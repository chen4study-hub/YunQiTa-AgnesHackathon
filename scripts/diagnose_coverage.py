"""Diagnostic only: untouched six-building test, no model/threshold changes."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import binomtest
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.selective import finite_quantile


def interval(covered, n):
    if not n:
        return None
    x = binomtest(int(covered), int(n)).proportion_ci(confidence_level=.95, method='exact')
    return [round(x.low, 4), round(x.high, 4)]


def summarize(frame):
    n = len(frame)
    if not n:
        return {'n': 0}
    hit = int(frame.hit.sum())
    return {'n': n, 'covered': hit, 'coverage': round(hit/n, 4), 'ci95_exact': interval(hit,n),
            'mae': round(float(np.mean(abs(frame.y-frame.point))), 3)}


def diagnose():
    cfg = config()
    data = adapt(pd.read_csv('data/bdg2_cohort.csv'), cfg)
    model = ResidualForecaster.load('models/paper-inspired-v1.joblib')
    times = sorted(data.timestamp.unique())
    a,b = int(len(times)*.65),int(len(times)*.85)
    pred = model.predict(data).frame
    pred = pred[pred.timestamp.isin(times[b:])]
    df = data.merge(pred, on=['timestamp','building_id'],validate='one_to_one')
    df['hit'] = (df.y >= df.lower) & (df.y <= df.upper)
    df = df[~df.abstain].copy()
    df['week'] = df.timestamp.dt.strftime('%Y-%m-%d')
    df['week_start'] = (df.timestamp - pd.to_timedelta(df.timestamp.dt.dayofweek,unit='D')).dt.floor('D').dt.strftime('%Y-%m-%d')
    df['day_type'] = np.where(df.timestamp.dt.dayofweek >= 5,'weekend','weekday')
    df['period'] = pd.cut(df.timestamp.dt.hour,[-1,5,11,17,23],labels=['night','morning','afternoon','evening'])
    df['season'] = df.timestamp.dt.month.map({10:'autumn',11:'autumn',12:'winter'})
    stats = {'overall': summarize(df), 'by_building': {}, 'by_week': {},
             'day_type': {}, 'period': {}, 'season': {}}
    for key, col in [('by_building','building_id'),('by_week','week_start'),('day_type','day_type'),('period','period'),('season','season')]:
        stats[key] = {str(k):summarize(g) for k,g in df.groupby(col,observed=True)}
    n = len(df)
    # Naive pooled CI is shown for context; buildings/weeks are correlated.
    stats['overall']['nominal_inside_naive_ci'] = bool(stats['overall']['ci95_exact'][0] <= .905 <= stats['overall']['ci95_exact'][1])
    stats['calibration'] = {'train_end':str(times[a-1]),'calib_start':str(times[a]),
        'calib_end':str(times[b-1]),'test_start':str(times[b]),
        'calib_hours':b-a,'cq_hours':(b-a)-int((b-a)*cfg['conformal']['scale_fraction']),
        'alpha':cfg['conformal']['alpha'],'q_multiplier':model.multiplier,
        'threshold':model.threshold,'finite_sample_quantile_unit_check':finite_quantile([1,2,3,4],.25)}
    from src.conformal.replay_calibration import primitives
    from src.conformal.selective import apply_routing
    pr=primitives(model,data)
    cq=pr[pr.timestamp.isin(times[a:b][-stats['calibration']['cq_hours']:])]
    risks,_=apply_routing(model.refs,model._components(cq,cq.scale.to_numpy()),model.threshold,cfg['conformal']['risk_weights'])
    stats['calibration']['cq_rows']=len(cq)
    stats['calibration']['risk_retained_cq_rows']=int((risks<=model.threshold).sum())
    source=data[~data.building_id.eq('Robin_education_Billi')]
    frozen=ResidualForecaster(cfg).fit(source[source.timestamp.isin(times[:a])],source[source.timestamp.isin(times[a:b])])
    f=primitives(frozen,data);f=f[f.timestamp.isin(times[a:b])].copy()
    f['group']=np.where(f.building_id.eq('Robin_education_Billi'),'target','source')
    f['abs_error']=abs(f.y-f.point)
    stats['transfer_scale']={key:{'n':len(g),'abs_error_mean':float(g.abs_error.mean()),
       'scale_mean':float(g.scale.mean()),'normalized_mean':float(g.score.mean()),
       'normalized_p905':float(g.score.quantile(.905))} for key,g in f.groupby('group')}
    Path('experiments/coverage_diagnosis.json').write_text(json.dumps(stats,indent=2),encoding='utf-8')
    return stats


if __name__ == '__main__':
    x=diagnose()
    print(json.dumps({k:x[k] for k in ('overall','by_building','by_week','day_type','period','season','calibration')},indent=2))
