"""Extra latest/target-aligned causal lags; fixed-band direct models plus originalh1."""
import numpy as np
import pandas as pd
from src.models.direct_multi import features as base_features,COLUMNS,learner,WEIGHTS
from src.conformal.selective import finite_quantile
COLUMNS_V2=COLUMNS+['latest_23','latest_167','daily_target','weekly_target','target_disagreement']
from src.conformal.replay_calibration import primitives,run
from src.agent.confidence import gate_confidence


def features(data):
    d=data.sort_values('timestamp').reset_index(drop=True);y=d.set_index('timestamp').y
    f=base_features(d)
    f['latest_23']=f.origin.sub(pd.Timedelta(hours=23)).map(y)
    f['latest_167']=f.origin.sub(pd.Timedelta(hours=167)).map(y)
    f['daily_target']=f.target.sub(pd.Timedelta(hours=24)).map(y)
    f['weekly_target']=f.target.sub(pd.Timedelta(hours=168)).map(y)
    f['target_disagreement']=(f.load_t-f.daily_target).abs()
    f['anchor']=np.where(f.horizon<=3,f.load_t,f.daily_target)
    return f


def fit_month(frame,start,plan,variant):
    bands=[(2,24)] if variant=='latest_pooled' else [(2,3),(4,6),(7,12),(13,24)]
    models=[]
    for lo,hi in bands:
        group=frame[frame.horizon.between(lo,hi)]
        models.append((lo,hi,base_fit(group,start,plan)))
    return dict(version=plan['version'],variant=variant,bands=models)


def predict(bundle,frame,lookups=None):
    rows=[]
    for lo,hi,model in bundle['bands']:
        g=frame[frame.horizon.between(lo,hi)]
        rows.append(base_predict(model,g,lookups))
    return pd.concat(rows,ignore_index=True).sort_values(['origin','horizon'])


def one_step_at(data,origins,bundle):
    """Build targett+1row with real history only; target load/weather never used as feature."""
    model=bundle['backbone'];last=data.timestamp.max()
    # Append blank target row to permit forecasting after the final observed hour.
    blank=data.iloc[-1:].copy();blank['timestamp']=last+pd.Timedelta(hours=1);blank['y']=np.nan;blank['air_temperature']=np.nan
    source=pd.concat([data,blank],ignore_index=True)
    f=primitives(model,source);f=f[f.timestamp.isin(origins+pd.Timedelta(hours=1))].sort_values('timestamp')
    p=run(model,bundle['calibration'],f,.15,'cqr',quantile_models=bundle['quantile_models'])
    p['origin']=p.timestamp-pd.Timedelta(hours=1);p['target']=p.timestamp;p['horizon']=1
    origin_load=data.set_index('timestamp').y;p['load_t']=p.origin.map(origin_load)
    p['risk_threshold']=bundle['risk_threshold']
    if bundle.get('confidence_lookup'):
        values=[gate_confidence(bundle['confidence_lookup'],r.risk_score,r.risk_threshold,r.abstain) for r in p.itertuples()]
        p['confidence']=[v[0] for v in values];p['confidence_threshold']=[v[1] for v in values]
    else:p=p.drop(columns=['confidence'])
    return p.drop(columns=['timestamp'])


def base_fit(frame,start,plan):
    cal_start=start-pd.Timedelta(days=28);q_start=cal_start+pd.Timedelta(hours=int(28*24*.65))
    train=frame[(frame.target<cal_start)&frame.y.notna()]
    scale_rows=frame[(frame.origin>=cal_start)&(frame.target<q_start)&frame.y.notna()]
    cq=frame[(frame.origin>=q_start)&(frame.target<start)&frame.y.notna()]
    assert train.target.max()<scale_rows.origin.min() and scale_rows.target.max()<cq.origin.min() and cq.target.max()<start
    x=train[COLUMNS_V2];residual=train.y-train.anchor
    point=learner(plan).fit(x,residual)
    low=learner(plan,objective='quantile',alpha=.095/2).fit(x,residual)
    high=learner(plan,objective='quantile',alpha=1-.095/2).fit(x,residual)
    def point_at(f):return np.maximum(0.,f.anchor.to_numpy()+point.predict(f[COLUMNS_V2]))
    scale=learner(plan).fit(scale_rows[COLUMNS_V2],np.abs(scale_rows.y.to_numpy()-point_at(scale_rows)))
    prior=float(np.abs(train.y.to_numpy()-point_at(train)).mean());calibrations={}
    for h,g in cq.groupby('horizon'):
        s=np.maximum(.001,scale.predict(g[COLUMNS_V2]));comps=[s,g.disagreement.to_numpy(),np.full(len(g),prior),np.full(len(g),prior)]
        refs=[np.sort(v) for v in comps]
        risk=sum(w*np.searchsorted(r,v,side='right')/len(r) for w,r,v in zip(WEIGHTS,refs,comps))
        threshold=float(np.quantile(risk,.85,method='higher'));kept=risk<=threshold
        lo=g.anchor.to_numpy()+low.predict(g[COLUMNS_V2]);hi=g.anchor.to_numpy()+high.predict(g[COLUMNS_V2])
        scores=np.maximum.reduce([np.minimum(lo,hi)-g.y.to_numpy(),g.y.to_numpy()-np.maximum(lo,hi),np.zeros(len(g))])
        calibrations[int(h)]={'refs':refs,'threshold':threshold,'q':finite_quantile(scores[kept],.095),'n':len(g)}
    return dict(version=plan['version'],point=point,low=low,high=high,scale=scale,prior=prior,calibrations=calibrations,
        train_target_end=str(train.target.max()),scale_target_end=str(scale_rows.target.max()),cq_origin_start=str(cq.origin.min()),
        cq_target_end=str(cq.target.max()),origin_month=start.strftime('%Y-%m'))


def base_predict(bundle,frame,lookups=None):
    """Prediction is independent of frame.y; scoring may use y only after issuance."""
    x=frame[COLUMNS_V2];anchor=frame.anchor.to_numpy();point=np.maximum(0.,anchor+bundle['point'].predict(x))
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
