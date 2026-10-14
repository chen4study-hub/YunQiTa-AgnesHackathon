"""Sequential historical backtests: frozen risk gate, update only AFTER observing y.

These procedures measure retained coverage empirically; no conditional guarantee.
The caller supplies already issue-time-safe point/scale predictions.
"""
from collections import deque
import numpy as np
import pandas as pd
from .selective import finite_quantile


def risk_reference(model, frame, rho):
    risk = sum(w * np.searchsorted(ref, comp, side='right') / len(ref)
               for w, ref, comp in zip(model.cfg['conformal']['risk_weights'], model.refs,
                                      model._components(frame, frame.scale.to_numpy())))
    return risk, float(np.quantile(risk, 1-rho, method='higher'))


def primitives(model, frame):
    f, _ = model._matrix(frame)
    f = f.copy()
    f['point'] = model._point(f)
    f['scale'] = np.maximum(model.cfg['conformal']['min_scale'],
                           model.scale_model.predict(f[model.columns]))
    f['score'] = np.abs(f.y-f.point)/f.scale
    f['period'] = f.timestamp.dt.hour//6
    return f


def run(model, cq, evaluation, rho, method='static', weeks=2, gamma=.02, quantile_models=None,
        min_calibration_rows=30, alpha_bounds=(.005,.4)):
    alpha = float(model.cfg['conformal']['alpha'])
    # Both reference distributions and gate threshold come only from Cq.
    refs = [np.sort(np.asarray(c)) for c in model._components(cq, cq.scale.to_numpy())]
    weights = model.cfg['conformal']['risk_weights']
    def risk(f):
        return sum(w*np.searchsorted(ref,comp,side='right')/len(ref)
                   for w,ref,comp in zip(weights,refs,model._components(f,f.scale.to_numpy())))
    crisk = risk(cq)
    threshold = float(np.quantile(crisk,1-rho,method='higher'))
    pool = cq.loc[crisk<=threshold].copy()
    base_q = finite_quantile(pool.score,alpha)
    period_q = {int(k):finite_quantile(g.score,alpha) for k,g in pool.groupby('period') if len(g)>=min_calibration_rows}
    history = deque((row.timestamp, float(row.score)) for row in pool.itertuples())
    current_alpha = alpha
    risk_eval = risk(evaluation)
    records=[]
    if method=='cqr':
        lo_model,hi_model=quantile_models
        lo_cal=np.asarray(lo_model.predict(cq[model.columns]))+cq.lag_1.to_numpy()
        hi_cal=np.asarray(hi_model.predict(cq[model.columns]))+cq.lag_1.to_numpy()
        raw_low=np.minimum(lo_cal,hi_cal); raw_high=np.maximum(lo_cal,hi_cal)
        cscore=np.maximum.reduce([raw_low-cq.y.to_numpy(),cq.y.to_numpy()-raw_high,np.zeros(len(cq))])
        cqr_q=finite_quantile(cscore[crisk<=threshold],alpha)
        lo_pred=lo_model.predict(evaluation[model.columns])+evaluation.lag_1.to_numpy()
        hi_pred=hi_model.predict(evaluation[model.columns])+evaluation.lag_1.to_numpy()
    for j,row in enumerate(evaluation.itertuples()):
        gate = bool(risk_eval[j]>threshold)
        q=base_q
        if method in ('rolling','aci'):
            cutoff=row.timestamp-pd.Timedelta(weeks=weeks)
            while history and history[0][0]<cutoff: history.popleft()
            if len(history)>=min_calibration_rows:
                q=finite_quantile([s for _,s in history],current_alpha if method=='aci' else alpha)
        elif method=='mondrian': q=period_q.get(int(row.period),base_q)
        lower=max(0.,row.point-q*row.scale);upper=row.point+q*row.scale
        if method=='cqr':
            lower=max(0.,min(row.point,min(lo_pred[j],hi_pred[j])-cqr_q))
            upper=max(row.point,max(lo_pred[j],hi_pred[j])+cqr_q)
        wide=(upper-lower)/max(row.point,1)>model.cfg['conformal']['max_relative_width']
        abstain=bool(gate or wide)
        hit=bool(lower<=row.y<=upper)
        records.append(dict(timestamp=row.timestamp,building_id=row.building_id,y=float(row.y),
            point=float(row.point),lower=float(lower),upper=float(upper),confidence=1-alpha,
            abstain=abstain,abstain_reason='routing_risk_above_threshold' if gate else
            'interval_too_wide' if wide else None,risk_score=float(risk_eval[j]),
            hit=hit,scale=float(row.scale),effective_alpha=current_alpha))
        # Only completed past risk-gate-retained outcomes enter the residual pool.
        # Width-rejected rows are included deliberately: otherwise very wide intervals
        # stop receiving feedback. ACI alpha feedback itself uses final retained rows.
        # The current y is read only AFTER its interval is fixed.
        if not gate:
            history.append((row.timestamp,float(row.score)))
            if method=='aci' and not wide:
                current_alpha=float(np.clip(current_alpha+gamma*(alpha-int(not hit)),*alpha_bounds))
    return pd.DataFrame(records)


def summary(pred):
    retained=pred[~pred.abstain]
    if retained.empty: raise ValueError('empty retained evaluation')
    return dict(n=len(pred),retained_n=len(retained),
        rejection_rate=float(pred.abstain.mean()),retained_picp=float(retained.hit.mean()),
        retained_mae=float(abs(retained.y-retained.point).mean()),
        mae=float(abs(pred.y-pred.point).mean()),rmse=float(np.sqrt(np.mean((pred.y-pred.point)**2))),
        width=float((retained.upper-retained.lower).mean()))
