"""Overlapping causal experts, mixing BEFORE per-horizon risk/CQR recalibration."""
import numpy as np
import pandas as pd
from src.models.shortfix_multi import fit_month as fit_v2,predict as predict_v2,base_fit,base_predict,COLUMNS_V2,features
from src.models.direct_multi import WEIGHTS
from src.conformal.selective import finite_quantile
from src.agent.confidence import gate_confidence


def expert_frame(frame,short):
    f=frame.copy();f['anchor']=f.load_t if short else f.daily_target
    return f


def raw(expert,frame):
    x=frame[COLUMNS_V2];anchor=frame.anchor.to_numpy();prior=expert['prior']
    return dict(point=np.maximum(0,anchor+expert['point'].predict(x)),low=anchor+expert['low'].predict(x),
        high=anchor+expert['high'].predict(x),scale=np.maximum(.001,expert['scale'].predict(x)),prior=prior)


def mixed(bundle,frame):
    short=raw(bundle['short'],expert_frame(frame,True));long=raw(bundle['long'],expert_frame(frame,False))
    weight=frame.horizon.map(lambda h:bundle['weights'][str(int(h))]).to_numpy()
    return {k:(1-weight)*short[k]+weight*long[k] for k in short}


def fit_month(frame,start,plan,weights,base=None,experts=None):
    base=base or fit_v2(frame,start,plan,'latest_segmented')
    if experts is None:
        short=base_fit(expert_frame(frame[frame.horizon.between(2,6)],True),start,plan)
        long=base_fit(expert_frame(frame[frame.horizon.between(3,6)],False),start,plan)
    else:short,long=experts
    b=dict(version=plan['version'],base=base,short=short,long=long,weights=weights,calibrations={})
    q_start=start-pd.Timedelta(days=28)+pd.Timedelta(hours=int(28*24*.65))
    cq=frame[(frame.origin>=q_start)&(frame.target<start)&frame.y.notna()&frame.horizon.between(3,6)]
    for h,g in cq.groupby('horizon'):
        r=mixed(b,g);comps=[r['scale'],g.disagreement.to_numpy(),r['prior'],r['prior']]
        refs=[np.sort(v) for v in comps];risk=sum(w*np.searchsorted(ref,v,side='right')/len(ref) for w,ref,v in zip(WEIGHTS,refs,comps))
        threshold=float(np.quantile(risk,.85,method='higher'));kept=risk<=threshold
        score=np.maximum.reduce([np.minimum(r['low'],r['high'])-g.y.to_numpy(),g.y.to_numpy()-np.maximum(r['low'],r['high']),np.zeros(len(g))])
        b['calibrations'][int(h)]=dict(refs=refs,threshold=threshold,q=finite_quantile(score[kept],.095),n=len(g))
    return b


def predict(bundle,frame,lookups=None):
    ordinary=frame[~frame.horizon.between(3,6)&frame.horizon.ge(2)]
    rows=[]
    for lo,hi,model in bundle['base']['bands']:
        g=ordinary[ordinary.horizon.between(lo,hi)]
        if len(g):rows.append(base_predict(model,g,lookups))
    for h,g in frame[frame.horizon.between(3,6)].groupby('horizon'):
        r=mixed(bundle,g);cal=bundle['calibrations'][int(h)]
        comps=[r['scale'],g.disagreement.to_numpy(),r['prior'],r['prior']]
        risk=sum(w*np.searchsorted(ref,v,side='right')/len(ref) for w,ref,v in zip(WEIGHTS,cal['refs'],comps))
        out=g[['origin','target','horizon','y','load_t']].copy();out['point']=r['point'];out['scale']=r['scale']
        out['lower']=np.maximum(0,np.minimum(r['point'],np.minimum(r['low'],r['high'])-cal['q']))
        out['upper']=np.maximum(r['point'],np.maximum(r['low'],r['high'])+cal['q'])
        out['risk_score']=risk;out['risk_threshold']=cal['threshold']
        out['abstain']=(risk>cal['threshold'])|((out.upper-out.lower)/np.maximum(out.point,1)>1.)
        out['hit']=(out.lower<=out.y)&(out.y<=out.upper)
        if lookups:
            v=[gate_confidence(lookups[int(h)],a,b,c) for a,b,c in zip(out.risk_score,out.risk_threshold,out.abstain)]
            out['confidence']=[x[0] for x in v];out['confidence_threshold']=[x[1] for x in v]
        rows.append(out)
    return pd.concat(rows,ignore_index=True).sort_values(['origin','horizon'])


def seam_metrics(frame,a=3,b=4):
    p=frame.pivot(index='origin',columns='horizon',values='point');y=frame.pivot(index='origin',columns='horizon',values='y')
    delta=p[b]-p[a];truth=y[b]-y[a];keep=truth.notna()
    return dict(n=int(keep.sum()),mean_abs_jump=float(delta[keep].abs().mean()),median_abs_jump=float(delta[keep].abs().median()),
        p95_abs_jump=float(delta[keep].abs().quantile(.95)),max_abs_jump=float(delta[keep].abs().max()),
        mean_abs_delta_error=float((delta[keep]-truth[keep]).abs().mean()))
