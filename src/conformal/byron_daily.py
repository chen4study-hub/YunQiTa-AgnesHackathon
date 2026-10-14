"""Byron-only deployed daily CQR/risk calibration; point models stay frozen."""
import copy
import numpy as np
import pandas as pd
from .daily_local import prepare,fit_local,issue
from src.agent.confidence import gate_confidence

BUILDING='Hog_office_Byron'
VERSION='byron-daily10-v1'
DAYS=10
MIN_ROWS=120


def calibration_state(frame,day,cfg,train_end=None):
    day=pd.Timestamp(day).floor('D')
    if not frame.building_id.eq(BUILDING).all():raise ValueError('daily deployment is Byron only')
    cal=frame[(frame.timestamp>=day-pd.Timedelta(days=DAYS)) & (frame.timestamp<day) & frame.y.notna()]
    if train_end is not None:cal=cal[cal.timestamp>pd.Timestamp(train_end)]
    if len(cal)<MIN_ROWS:raise ValueError('insufficient completed past calibration; stop automatic control')
    assert cal.timestamp.min()>=day-pd.Timedelta(days=DAYS)
    assert cal.timestamp.max()<day
    if train_end is not None:assert pd.Timestamp(train_end)<cal.timestamp.min()
    return fit_local(cal,cfg,'cqr')


def issued(frame,state,cfg,lookup):
    out=issue(frame,state,cfg)
    assert (out.cal_end<out.timestamp).all()
    values=[gate_confidence(lookup,r.risk_score,r.threshold,r.abstain) for r in out.itertuples()]
    out['confidence']=[v[0] for v in values];out['confidence_threshold']=[v[1] for v in values]
    out['risk_threshold']=out.threshold
    out['abstain_reason']=np.where(out.risk_rejected,'routing_risk_above_threshold',np.where(out.width_rejected,'interval_too_wide',None))
    return out


def one_step(bundle,data,target):
    """data may contain blank target only, no target-day outcome enters fit."""
    target=pd.Timestamp(target);day=target.floor('D')
    if not data.building_id.eq(BUILDING).all():raise ValueError('Byron only')
    cfg=copy.deepcopy(bundle['backbone'].cfg['conformal']);cfg['rejection_fraction']=.15
    f=prepare(bundle['backbone'],data[data.timestamp<=target],bundle['quantile_models'])
    state=calibration_state(f,day,cfg,bundle['train_end'])
    ev=f[f.timestamp.eq(target)]
    if len(ev)!=1:raise ValueError('insufficient issue-time feature history')
    assert state['cal_end']<day<=target
    return issued(ev,state,cfg,bundle['confidence_lookup'])


def multi_primitives(bundle,features):
    """Recompute past errors using frozen current-month models; no retraining."""
    from src.models.blend_multi import mixed,expert_frame
    from src.models.shortfix_multi import COLUMNS_V2
    f=features.copy();rows=[]
    for h,g in f.groupby('horizon',sort=True):
        if h==1:continue
        if 3<=h<=6:r=mixed(bundle,g);train_end=bundle['short']['train_target_end']
        else:
            model=next(m for lo,hi,m in bundle['base']['bands'] if lo<=h<=hi)
            x=g[COLUMNS_V2];a=g.anchor.to_numpy()
            r=dict(point=np.maximum(0,a+model['point'].predict(x)),low=a+model['low'].predict(x),
                   high=a+model['high'].predict(x),scale=np.maximum(.001,model['scale'].predict(x)),prior=model['prior'])
            train_end=model['train_target_end']
        out=g[['origin','target','horizon','y','disagreement']].copy()
        out['timestamp']=out.target;out['building_id']=BUILDING;out['point']=r['point']
        out['raw_low']=np.minimum(r['low'],r['high']);out['raw_high']=np.maximum(r['low'],r['high'])
        out['risk_0']=r['scale'];out['risk_1']=out.disagreement
        out['risk_2']=r['prior'];out['risk_3']=r['prior'];out['train_end']=train_end
        rows.append(out)
    return pd.concat(rows,ignore_index=True)


def daily_multi(primitives,start,end,lookups):
    from src.models.direct_multi import WEIGHTS
    cfg=dict(risk_weights=WEIGHTS,rejection_fraction=.15,alpha=.095,max_relative_width=1.)
    rows=[]
    for day in pd.date_range(start,end-pd.Timedelta(days=1),freq='D'):
        for h,one in primitives.groupby('horizon'):
            ev=one[(one.origin>=day)&(one.origin<day+pd.Timedelta(days=1))]
            if ev.empty:continue
            # completed TARGET labels only; origin is always before target.
            state=calibration_state(one,day,cfg,one.train_end.iloc[0])
            assert state['cal_end']<day<=ev.origin.min()
            out=issued(ev,state,cfg,lookups[int(h)])
            out['origin']=ev.origin.to_numpy();out['target']=ev.target.to_numpy();out['horizon']=int(h)
            out['y']=ev.y.to_numpy();out['hit']=(out.y>=out.lower)&(out.y<=out.upper)
            rows.append(out)
    return pd.concat(rows,ignore_index=True).sort_values(['origin','horizon'])
