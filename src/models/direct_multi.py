"""Origin-causal direct multi-step residual features and per-horizon CQR gates."""
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.conformal.selective import finite_quantile
from src.agent.confidence import gate_confidence

COLUMNS=['horizon','target_hour','target_weekday','target_month','target_weekend','holiday',
    'load_t','load_1','load_24','load_168','roll_24','roll_168','anchor','disagreement','weather_persistence']
WEIGHTS=[.7,.15,.1,.05]


def features(data):
    """Labels are separate from feature columns. No shifted-future weather/load features."""
    d=data.sort_values('timestamp').reset_index(drop=True);y=d.y
    base=pd.DataFrame({'origin':d.timestamp,'load_t':y,'load_1':y.shift(1),'load_24':y.shift(24),'load_168':y.shift(168),
        'roll_24':y.rolling(24).mean(),'roll_168':y.rolling(168).mean(),
        'weather_persistence':d.air_temperature.ffill()})
    base['disagreement']=(base.load_t-base.load_24).abs()
    holidays=USFederalHolidayCalendar().holidays('2016-01-01','2018-12-31').strftime('%Y-%m-%d')
    frames=[]
    for h in range(1,25):
        f=base.copy();f['horizon']=h;f['target']=f.origin+pd.Timedelta(hours=h)
        f['anchor']=y.shift(24-h);f['y']=y.shift(-h)
        f['target_hour']=f.target.dt.hour;f['target_weekday']=f.target.dt.dayofweek;f['target_month']=f.target.dt.month
        f['target_weekend']=(f.target_weekday>=5).astype(int);f['holiday']=f.target.dt.strftime('%Y-%m-%d').isin(holidays).astype(int)
        frames.append(f.dropna(subset=[c for c in COLUMNS if c!='weather_persistence']))
    return pd.concat(frames,ignore_index=True).sort_values(['origin','horizon'])


def learner(plan,**kwargs):
    return LGBMRegressor(**plan['parameters'],random_state=plan['seed'],verbosity=-1,**kwargs)


def fit_month(frame,start,plan):
    cal_start=start-pd.Timedelta(days=28);q_start=cal_start+pd.Timedelta(hours=int(28*24*.65))
    train=frame[(frame.target<cal_start)&frame.y.notna()]
    scale_rows=frame[(frame.origin>=cal_start)&(frame.target<q_start)&frame.y.notna()]
    cq=frame[(frame.origin>=q_start)&(frame.target<start)&frame.y.notna()]
    assert train.target.max()<scale_rows.origin.min() and scale_rows.target.max()<cq.origin.min() and cq.target.max()<start
    x=train[COLUMNS];residual=train.y-train.anchor
    point=learner(plan).fit(x,residual)
    low=learner(plan,objective='quantile',alpha=.095/2).fit(x,residual)
    high=learner(plan,objective='quantile',alpha=1-.095/2).fit(x,residual)
    def point_at(f):return np.maximum(0.,f.anchor.to_numpy()+point.predict(f[COLUMNS]))
    scale=learner(plan).fit(scale_rows[COLUMNS],np.abs(scale_rows.y.to_numpy()-point_at(scale_rows)))
    prior=float(np.abs(train.y.to_numpy()-point_at(train)).mean());calibrations={}
    for h,g in cq.groupby('horizon'):
        s=np.maximum(.001,scale.predict(g[COLUMNS]));comps=[s,g.disagreement.to_numpy(),np.full(len(g),prior),np.full(len(g),prior)]
        refs=[np.sort(v) for v in comps]
        risk=sum(w*np.searchsorted(r,v,side='right')/len(r) for w,r,v in zip(WEIGHTS,refs,comps))
        threshold=float(np.quantile(risk,.85,method='higher'));kept=risk<=threshold
        lo=g.anchor.to_numpy()+low.predict(g[COLUMNS]);hi=g.anchor.to_numpy()+high.predict(g[COLUMNS])
        scores=np.maximum.reduce([np.minimum(lo,hi)-g.y.to_numpy(),g.y.to_numpy()-np.maximum(lo,hi),np.zeros(len(g))])
        calibrations[int(h)]={'refs':refs,'threshold':threshold,'q':finite_quantile(scores[kept],.095),'n':len(g)}
    return dict(version=plan['version'],point=point,low=low,high=high,scale=scale,prior=prior,calibrations=calibrations,
        train_target_end=str(train.target.max()),scale_target_end=str(scale_rows.target.max()),cq_origin_start=str(cq.origin.min()),
        cq_target_end=str(cq.target.max()),origin_month=start.strftime('%Y-%m'))


def predict(bundle,frame,lookups=None):
    """Prediction is independent of frame.y; scoring may use y only after issuance."""
    x=frame[COLUMNS];anchor=frame.anchor.to_numpy();point=np.maximum(0.,anchor+bundle['point'].predict(x))
    lo=anchor+bundle['low'].predict(x);hi=anchor+bundle['high'].predict(x);scale=np.maximum(.001,bundle['scale'].predict(x))
    out=frame[['origin','target','horizon','y','load_t']].copy().reset_index(drop=True)
    out['point']=point;out['scale']=scale;out['lower']=0.;out['upper']=0.;out['risk_score']=0.;out['risk_threshold']=0.
    for h,index in out.groupby('horizon').groups.items():
        idx=np.asarray(list(index));cal=bundle['calibrations'][int(h)]
        comps=[scale[idx],frame.disagreement.to_numpy()[idx],np.full(len(idx),bundle['prior']),np.full(len(idx),bundle['prior'])]
        risk=sum(w*np.searchsorted(r,v,side='right')/len(r) for w,r,v in zip(WEIGHTS,cal['refs'],comps))
        out.loc[idx,'lower']=np.maximum(0.,np.minimum(point[idx],np.minimum(lo[idx],hi[idx])-cal['q']))
        out.loc[idx,'upper']=np.maximum(point[idx],np.maximum(lo[idx],hi[idx])+cal['q'])
        out.loc[idx,'risk_score']=risk;out.loc[idx,'risk_threshold']=cal['threshold']
    out['abstain']=(out.risk_score>out.risk_threshold)|((out.upper-out.lower)/np.maximum(out.point,1)>1.)
    out['hit']=(out.lower<=out.y)&(out.y<=out.upper)
    if lookups:
        values=[gate_confidence(lookups[int(r.horizon)],r.risk_score,r.risk_threshold,r.abstain) for r in out.itertuples()]
        out['confidence']=[v[0] for v in values];out['confidence_threshold']=[v[1] for v in values]
    return out
