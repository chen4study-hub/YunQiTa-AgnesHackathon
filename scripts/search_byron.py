"""Finite, validation-only interval search; writes logs/results, never promotes across cohorts."""
import json
import time
from pathlib import Path
import pandas as pd
from lightgbm import LGBMRegressor
from scipy.stats import binomtest
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run, summary


def fit_quantiles(model, frame):
    f,_=model._matrix(frame)
    settings=config('configs/interval_search.yaml')['cqr']
    alpha=model.cfg['conformal']['alpha']
    options=dict(n_estimators=settings['n_estimators'],learning_rate=settings['learning_rate'],
                 num_leaves=settings['num_leaves'],verbosity=-1,n_jobs=2,random_state=model.cfg['seed'])
    lo=LGBMRegressor(objective='quantile',alpha=alpha/2,**options)
    hi=LGBMRegressor(objective='quantile',alpha=1-alpha/2,**options)
    lo.fit(f[model.columns],f.y-f.lag_1);hi.fit(f[model.columns],f.y-f.lag_1)
    return lo,hi


def main():
    start=time.monotonic()
    c=config('configs/byron2017.yaml');data=adapt(pd.read_csv('data/byron2017.csv'),c)
    times=sorted(data.timestamp.unique());p,q,a,b=[int(len(times)*f) for f in (.45,.55,.65,.85)]
    model=ResidualForecaster(c).fit(data[data.timestamp.isin(times[:p])],data[data.timestamp.isin(times[p:q])])
    f=primitives(model,data[data.timestamp.isin(times[:a])])
    ct=times[p:q];cq_times=ct[int(len(ct)*.65):]
    cq=f[f.timestamp.isin(cq_times)]
    valid=f[f.timestamp.isin(times[q:a])].sort_values('timestamp')
    quantile_models=fit_quantiles(model,data[data.timestamp.isin(times[:p])])
    search=config('configs/interval_search.yaml')
    variants=[('static',0)]+[('rolling',w) for w in search['rolling_weeks']]+[
        ('aci',search['aci']['weeks']),('mondrian',0),('cqr',0)]
    rows=[];choices={}
    for rho in search['rejection_fractions']:
        group=[]
        for method,weeks in variants:
            result=run(model,cq,valid,rho,method,weeks=weeks or 2,
                       gamma=search['aci']['gamma'],quantile_models=quantile_models,
                       min_calibration_rows=search['mondrian']['min_calibration_rows'],
                       alpha_bounds=(search['aci']['alpha_min'],search['aci']['alpha_max']))
            stats=summary(result)
            successes=int(result.loc[~result.abstain,'hit'].sum())
            ci=binomtest(successes,stats['retained_n']).proportion_ci(method='exact')
            row=dict(split='validation',rho=rho,method=method,weeks=weeks,seed=42,**stats,
                     ci_low=float(ci.low),ci_high=float(ci.high),elapsed_seconds=time.monotonic()-start)
            rows.append(row);group.append(row)
        # Coverage floor first; avoid inventing point improvement from pure interval changes.
        eligible=[r for r in group if r['retained_picp']>=.905 or r['ci_low']<=.905<=r['ci_high']]
        if not eligible: eligible=[r for r in group if r['method']=='static']
        selected=min(eligible,key=lambda r:(r['width'],r['method'],r['weeks']))
        choices[str(rho)]={'method':selected['method'],'weeks':selected['weeks'] or 2,
                          'validation':selected,'selection_basis':'validation coverage then retained width; not champion MAE improvement'}
    pd.DataFrame(rows).to_csv('experiments/byron_validation_search.csv',index=False)
    Path('experiments/byron_selected_profiles.json').write_text(json.dumps(choices,indent=2),encoding='utf-8')
    print(json.dumps(choices,indent=2),flush=True)
    # Final evaluation only AFTER complete validation choice. No further selection on test.
    final=ResidualForecaster.load('models/byron2017-v1.joblib')
    f=primitives(final,data)
    ct=times[a:b];cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
    test=f[f.timestamp.isin(times[b:])].sort_values('timestamp')
    qfinal=fit_quantiles(final,data[data.timestamp.isin(times[:a])])
    finalrows=[]
    for rho in search['rejection_fractions']:
        choice=choices[str(rho)]
        result=run(final,cq,test,rho,choice['method'],weeks=choice['weeks'],
                   gamma=search['aci']['gamma'],quantile_models=qfinal,
                   min_calibration_rows=search['mondrian']['min_calibration_rows'],
                   alpha_bounds=(search['aci']['alpha_min'],search['aci']['alpha_max']))
        row=dict(split='test',rho=rho,method=choice['method'],weeks=choice['weeks'],**summary(result))
        finalrows.append(row)
        result.to_csv(f'data/byron_test_rejection_{int(rho*100)}.csv',index=False)
    pd.DataFrame(finalrows).to_csv('experiments/byron_operating_points.csv',index=False)
    print('FINAL',json.dumps(finalrows,indent=2),flush=True)
    print('elapsed',round(time.monotonic()-start,3),flush=True)


if __name__=='__main__':main()
