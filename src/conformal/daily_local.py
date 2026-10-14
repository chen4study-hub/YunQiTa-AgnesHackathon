"""Offline daily local calibration. No serving/registry integration.

Frozen primitives may be recomputed using the current monthly model on PAST
observations. Risk selection is empirical, not a conditional coverage guarantee.
"""
import numpy as np
import pandas as pd
from .selective import finite_quantile


def prepare(model, frame, quantiles=None):
    from .replay_calibration import primitives
    f = primitives(model, frame)
    for i, component in enumerate(model._components(f, f.scale.to_numpy())):
        f[f'risk_{i}'] = component
    if quantiles is not None:
        a = quantiles[0].predict(f[model.columns], num_threads=1) + f.lag_1.to_numpy()
        b = quantiles[1].predict(f[model.columns], num_threads=1) + f.lag_1.to_numpy()
        f['raw_low'] = np.minimum(a, b)
        f['raw_high'] = np.maximum(a, b)
    return f


def fit_local(calibration, cfg, kind='cqr'):
    if calibration.empty or calibration.building_id.nunique() > 1:
        raise ValueError('one nonempty building required for local fit')
    return fit_reference(calibration, cfg, kind)


def fit_reference(calibration, cfg, kind):
    columns = [f'risk_{i}' for i in range(len(cfg['risk_weights']))]
    values = calibration[columns].to_numpy(dtype=float)
    if not len(values) or not np.isfinite(values).all():
        raise ValueError('invalid calibration components')
    refs = [np.sort(values[:, i]) for i in range(values.shape[1])]
    risk = risk_values(calibration, refs, cfg['risk_weights'])
    threshold = float(np.quantile(risk, 1-cfg['rejection_fraction'], method='higher'))
    kept = risk <= threshold
    if kind == 'cqr':
        score = np.maximum.reduce([calibration.raw_low.to_numpy()-calibration.y.to_numpy(),
            calibration.y.to_numpy()-calibration.raw_high.to_numpy(), np.zeros(len(calibration))])
    elif kind == 'normalized':
        score = np.abs(calibration.y-calibration.point).to_numpy()/calibration.scale.to_numpy()
    else:
        raise ValueError('unsupported interval kind')
    return {'refs': refs, 'threshold': threshold,
        'q': finite_quantile(score[kept], cfg['alpha']), 'kind': kind,
        'cal_start': calibration.timestamp.min(), 'cal_end': calibration.timestamp.max(),
        'cal_n': len(calibration), 'cal_kept_n': int(kept.sum())}


def risk_values(frame, refs, weights):
    return sum(w*np.searchsorted(ref, frame[f'risk_{i}'], side='right')/len(ref)
        for i, (w, ref) in enumerate(zip(weights, refs)))


def issue(frame, state, cfg):
    """Fix intervals/decisions without consulting this frame's outcome y."""
    point = frame.point.to_numpy()
    risk = risk_values(frame, state['refs'], cfg['risk_weights'])
    if state['kind'] == 'cqr':
        low = np.maximum(0, np.minimum(point, frame.raw_low.to_numpy()-state['q']))
        high = np.maximum(point, frame.raw_high.to_numpy()+state['q'])
    else:
        low = np.maximum(0, point-state['q']*frame.scale.to_numpy())
        high = point+state['q']*frame.scale.to_numpy()
    gate = risk > state['threshold']
    wide = (high-low)/np.maximum(point, 1) > cfg['max_relative_width']
    out = frame[['timestamp', 'building_id', 'point']].copy()
    out['lower'] = low; out['upper'] = high; out['risk_score'] = risk
    out['risk_rejected'] = gate; out['width_rejected'] = wide
    out['abstain'] = gate | wide
    for key in ('threshold', 'q', 'cal_start', 'cal_end', 'cal_n', 'cal_kept_n'):
        out[key] = state[key]
    return out


def daily(frame, evaluation_start, cfg, kind='cqr', days=10, min_rows=120):
    rows = []
    for building, one in frame.groupby('building_id', sort=True):
        for day, ev in one[one.timestamp >= evaluation_start].groupby(one.timestamp.dt.floor('D')):
            cal = one[(one.timestamp >= day-pd.Timedelta(days=days)) & (one.timestamp < day)]
            if len(cal) < min_rows:
                raise ValueError(f'insufficient past calibration: {building} {day}')
            assert cal.timestamp.max() < ev.timestamp.min()
            state = fit_local(cal, cfg, kind)
            issued = issue(ev, state, cfg)
            issued['y'] = ev.y.to_numpy()  # scoring only AFTER decisions fixed
            issued['hit'] = (issued.y >= issued.lower) & (issued.y <= issued.upper)
            rows.append(issued)
    return pd.concat(rows, ignore_index=True)


def metrics(pred, alpha=.095):
    kept = pred[~pred.abstain]; err = pred.y-pred.point
    width = pred.upper-pred.lower
    return {'n': len(pred), 'retained_n': len(kept), 'all_coverage': float(pred.hit.mean()),
        'retained_coverage': float(kept.hit.mean()) if len(kept) else None,
        'rejection_rate': float(pred.abstain.mean()),
        'risk_rejection_rate': float(pred.risk_rejected.mean()) if 'risk_rejected' in pred else None,
        'width_rejection_rate': float(pred.width_rejected.mean()) if 'width_rejected' in pred else None,
        'mae': float(err.abs().mean()), 'rmse': float(np.sqrt(np.mean(err**2))),
        'retained_mae': float((kept.y-kept.point).abs().mean()) if len(kept) else None,
        'width_all': float(width.mean()),
        'width_retained': float((kept.upper-kept.lower).mean()) if len(kept) else None,
        'interval_score': float((width+2/alpha*(np.maximum(pred.lower-pred.y, 0)+np.maximum(pred.y-pred.upper, 0))).mean())}
