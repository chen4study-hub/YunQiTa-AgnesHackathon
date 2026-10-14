"""Experimental rolling CQR; frozen risk gate, past observed corrections only."""
from collections import deque
import numpy as np
import pandas as pd
from .selective import finite_quantile


def run_rolling_cqr(model,cq,evaluation,rho,quantile_models,weeks=2,min_rows=30):
    alpha=model.cfg['conformal']['alpha'];lo,hi=quantile_models
    refs=[np.sort(np.asarray(c)) for c in model._components(cq,cq.scale.to_numpy())]
    def risk(f):
        return sum(w*np.searchsorted(ref,comp,side='right')/len(ref)
            for w,ref,comp in zip(model.cfg['conformal']['risk_weights'],refs,
                                  model._components(f,f.scale.to_numpy())))
    def bounds(f):
        a=lo.predict(f[model.columns])+f.lag_1.to_numpy()
        b=hi.predict(f[model.columns])+f.lag_1.to_numpy()
        return np.minimum(a,b),np.maximum(a,b)
    cr=risk(cq);threshold=float(np.quantile(cr,1-rho,method='higher'))
    a,b=bounds(cq);scores=np.maximum.reduce([a-cq.y.to_numpy(),cq.y.to_numpy()-b,np.zeros(len(cq))])
    retained=cr<=threshold
    base=finite_quantile(scores[retained],alpha)
    history=deque((t,float(s)) for t,s,keep in zip(cq.timestamp,scores,retained) if keep)
    lower_raw,upper_raw=bounds(evaluation);risks=risk(evaluation);rows=[]
    for j,row in enumerate(evaluation.itertuples()):
        cutoff=row.timestamp-pd.Timedelta(weeks=weeks)
        while history and history[0][0]<cutoff: history.popleft()
        correction=finite_quantile([s for _,s in history],alpha) if len(history)>=min_rows else base
        lower=max(0.,min(row.point,lower_raw[j]-correction))
        upper=max(row.point,upper_raw[j]+correction)
        gate=bool(risks[j]>threshold)
        wide=(upper-lower)/max(row.point,1)>model.cfg['conformal']['max_relative_width']
        rows.append(dict(timestamp=row.timestamp,building_id=row.building_id,y=float(row.y),
            point=float(row.point),lower=float(lower),upper=float(upper),confidence=1-alpha,
            abstain=gate or wide,abstain_reason='routing_risk_above_threshold' if gate else
            'interval_too_wide' if wide else None,risk_score=float(risks[j]),
            hit=bool(lower<=row.y<=upper),scale=float(row.scale),effective_alpha=alpha))
        # Only AFTER issue-time bounds are fixed may this hour's actual load update calibration.
        if not gate:
            observed=max(lower_raw[j]-row.y,row.y-upper_raw[j],0.)
            history.append((row.timestamp,float(observed)))
    return pd.DataFrame(rows)
