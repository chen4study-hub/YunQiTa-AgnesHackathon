"""One foreground, single-thread stage at a time; immutable versioned receipts."""
import argparse
import copy
import hashlib
import json
import os
import time
from pathlib import Path

# Apply before importing numeric runtimes. LightGBM is additionally forced to 1.
for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = '1'
import joblib
import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits
from src.data.adapter import adapt, config
from src.conformal.daily_local import prepare, fit_reference, issue, daily, metrics

OUT = Path('experiments/calibration_v1')
CACHE = Path('data/calibration_v1')
PLAN = json.loads((OUT/'plan.json').read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def event(stage, **payload):
    line = json.dumps({'stage': stage, **payload}, ensure_ascii=False, allow_nan=False, default=str)
    print(line, flush=True)
    with (OUT/(stage+'_log.txt')).open('a', encoding='utf-8') as f:
        f.write(line+'\n')


def save(stage, result):
    result.update(plan_sha256=sha(OUT/'plan.json'), software={'numpy':np.__version__, 'pandas':pd.__version__},
        foreground=True, single_thread=True, live_updated=False)
    (OUT/(stage+'_results.json')).write_text(json.dumps(result, indent=2, allow_nan=False, default=str), encoding='utf-8')


def one_thread(model):
    model.point_model.set_params(n_jobs=1); model.scale_model.set_params(n_jobs=1)
    return model


def scored(f, state, cfg):
    p = issue(f, state, cfg);p['y'] = f.y.to_numpy()
    p['hit'] = (p.y >= p.lower) & (p.y <= p.upper)
    return p


def cache(name, pred):
    path = CACHE/(name+'.csv');pred.to_csv(path, index=False)
    return {'path':str(path), 'sha256':sha(path), 'rows':len(pred)}


def byron():
    root = Path('data/raw/bdg2')
    raw = pd.read_csv(root/'electricity_cleaned.csv', usecols=['timestamp','Hog_office_Byron'])
    raw = raw[raw.timestamp >= '2016-01-20 00:00:00'].rename(columns={'Hog_office_Byron':'meter_reading'})
    weather = pd.read_csv(root/'weather.csv', usecols=['timestamp','site_id','airTemperature','cloudCoverage'])
    weather = weather[weather.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature','cloudCoverage':'cloud_coverage'})
    raw = raw.merge(weather.drop(columns='site_id'), on='timestamp', how='left', validate='one_to_one')
    raw['building_id'] = 'Hog_office_Byron';raw['primary_use'] = 'Office'
    data = adapt(raw, config('configs/byron2017.yaml'))
    results=[];predictions=[];receipts=[];sources=[]
    for month in range(1,13):
        start = pd.Timestamp(year=2017, month=month, day=1, tz='UTC')
        path = Path(f'models/byron-expanded-holiday-monthly-v1-{start:%Y-%m}.joblib')
        bundle = joblib.load(path);model=one_thread(bundle['backbone'])
        quantiles=bundle['quantile_models']
        for q in quantiles:q.set_params(n_jobs=1)
        cfg=copy.deepcopy(model.cfg['conformal']);cfg['rejection_fraction']=PLAN['rho']
        assert pd.Timestamp(bundle['train_end']) < start-pd.Timedelta(days=14)
        assert pd.Timestamp(bundle['calibration_end']) < start
        f=prepare(model, data[data.timestamp < start+pd.offsets.MonthBegin(1)], quantiles)
        cq=f.merge(bundle['calibration'][['timestamp','building_id']],on=['timestamp','building_id'],validate='one_to_one')
        ev=f[f.timestamp >= start]
        static=scored(ev,fit_reference(cq,cfg,'cqr'),cfg)
        old=Path(f'data/monthly_backtest/{start:%Y-%m}_expanded_holiday_lgb_cqr.csv')
        cached=pd.read_csv(old)
        for col in ('point','lower','upper','risk_score'):
            np.testing.assert_allclose(static[col],cached[col],rtol=1e-9,atol=1e-7)
        assert np.array_equal(static.abstain.to_numpy(),cached.abstain.to_numpy())
        models={'monthly':static}
        # Restrict all local calibration to rows strictly AFTER current model training.
        local=f[f.timestamp > pd.Timestamp(bundle['train_end'])]
        for days in (10,7,14):
            p=daily(local,start,cfg,'cqr',days,PLAN['daily']['min_rows'])
            assert np.array_equal(static.point.to_numpy(),p.point.to_numpy())
            models[f'daily_{days}d']=p
        for name,p in models.items():
            p=p.assign(method=name);predictions.append(p)
            receipts.append(cache(f'byron_{start:%Y-%m}_{name}',p))
        row={'month':f'{start:%Y-%m}','metrics':{name:metrics(p) for name,p in models.items()},
            'training_end':bundle['train_end'],'baseline_cache_matched':True}
        results.append(row);sources.append({'artifact':str(path),'sha256':sha(path),'baseline_cache_sha256':sha(old)})
        event('byron', **row)
    allp=pd.concat(predictions,ignore_index=True)
    assert allp.groupby('method').size().eq(8760).all()
    pooled={name:metrics(p) for name,p in allp.groupby('method')}
    shock=allp[allp.timestamp.dt.strftime('%Y-%m-%d').eq('2017-05-09')]
    result={'status':'completed','monthly':results,'pooled':pooled,
        'may09':{name:metrics(p) for name,p in shock.groupby('method')},'sources':sources,
        'input_sha256':{'electricity':sha(root/'electricity_cleaned.csv'),'weather':sha(root/'weather.csv')},
        'predictions':receipts,'one_step_observed_lags':True}
    save('byron',result);event('byron',status='completed',pooled=pooled)


def six():
    path=Path('data/bdg2_cohort.csv');cfg=config('configs/baseline.yaml')
    data=adapt(pd.read_csv(path),cfg);model=one_thread(joblib.load('models/paper-inspired-v1.joblib'))
    f=prepare(model,data);times=sorted(data.timestamp.unique())
    a,b=int(len(times)*.65),int(len(times)*.85)
    ct=times[a:b];cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])];ev=f[f.timestamp.isin(times[b:])]
    cc=copy.deepcopy(cfg['conformal']);cc['rejection_fraction']=.30
    legacy=scored(ev,fit_reference(cq,cc,'normalized'),cc)
    original=model.predict(data).frame
    original=original[original.timestamp.isin(times[b:])].reset_index(drop=True)
    ordered=legacy.sort_values(['building_id','timestamp']).reset_index(drop=True)
    for col in ('point','lower','upper','risk_score'):
        np.testing.assert_allclose(ordered[col],original[col],rtol=1e-9,atol=1e-7)
    assert np.array_equal(ordered.abstain.to_numpy(),original.abstain.to_numpy())
    cc['rejection_fraction']=PLAN['rho']
    static=scored(ev,fit_reference(cq,cc,'normalized'),cc)
    loc=f[f.timestamp >= times[a]]
    models={'legacy_shared_rho30':legacy,'shared_rho15':static}
    for days in (10,7,14):models[f'daily_{days}d_rho15']=daily(loc,times[b],cc,'normalized',days)
    receipts=[];allp=[]
    for name,p in models.items():receipts.append(cache('six_'+name,p));allp.append(p.assign(method=name))
    allp=pd.concat(allp,ignore_index=True)
    rows=[]
    for building,g in allp.groupby('building_id'):
        row={'building':building,'metrics':{name:metrics(p) for name,p in g.groupby('method')}}
        rows.append(row);event('six',**row)
    result={'status':'completed','artifact':{'path':'models/paper-inspired-v1.joblib','sha256':sha('models/paper-inspired-v1.joblib')},
        'input_sha256':sha(path),'evaluation_start':str(times[b]),'evaluation_end':str(times[-1]),
        'legacy_replication_matched':True,'interval_kind':'normalized_not_cqr',
        'by_building':rows,'pooled':{name:metrics(p) for name,p in allp.groupby('method')},'predictions':receipts}
    save('six',result);event('six',status='completed',pooled=result['pooled'])
def cold():
    from lightgbm import LGBMRegressor
    from unittest.mock import patch
    from src.models.residual import ResidualForecaster
    from src.conformal.selective import finite_quantile
    path=Path('data/hog2017_cohort.csv');cfg=config('configs/byron2017.yaml')
    raw=pd.read_csv(path);ids=PLAN['cold']['targets']
    data=adapt(raw[raw.building_id.isin(ids)],cfg);rows=[];receipts=[]
    def serial_regressor(**kwargs):
        kwargs['n_jobs']=1
        return LGBMRegressor(**kwargs)
    first=pd.Timestamp('2017-07-01',tz='UTC');warm_end=first+pd.Timedelta(hours=168)
    for target in ids:
        t0=time.monotonic();source=data[~data.building_id.eq(target)]
        train=source[source.timestamp < pd.Timestamp('2017-06-01',tz='UTC')]
        cal=source[(source.timestamp >= pd.Timestamp('2017-06-01',tz='UTC')) & (source.timestamp < first)]
        # Existing class uses n_jobs=2: override only its constructor in this offline process.
        with patch('src.models.residual.LGBMRegressor',serial_regressor):
            model=ResidualForecaster(copy.deepcopy(cfg)).fit(train,cal)
        one=data[data.building_id.eq(target) & (data.timestamp >= first)]
        f=prepare(model,one).sort_values('timestamp').reset_index(drop=True)
        assert f.timestamp.min()==warm_end and train.building_id.ne(target).all() and cal.building_id.ne(target).all()
        predictions=[];week_rows=[]
        starts=pd.date_range(warm_end,f.timestamp.max().floor('D'),freq='7D')
        for start in starts:
            ev=f[(f.timestamp >= start) & (f.timestamp < start+pd.Timedelta(days=7))]
            past=f[(f.timestamp >= start-pd.Timedelta(days=PLAN['cold']['history_days'])) & (f.timestamp < start)]
            nfit=int(len(past)*PLAN['cold']['split']);fit=past.iloc[:nfit];qc=past.iloc[nfit:]
            enabled=False;correction=np.zeros(len(ev));validation={};q=None
            if len(fit)>=PLAN['cold']['minimum_fit_rows'] and len(qc)>=PLAN['cold']['minimum_calibration_rows']:
                assert fit.timestamp.max() < qc.timestamp.min() and qc.timestamp.max() < ev.timestamp.min()
                fix=LGBMRegressor(**PLAN['cold']['residual_model'],verbosity=-1,random_state=PLAN['seed'])
                fix.fit(fit[model.columns],fit.y-fit.point)
                corrected=np.maximum(0,qc.point.to_numpy()+fix.predict(qc[model.columns]))
                original_mae=float((qc.y-qc.point).abs().mean());candidate_mae=float(np.mean(abs(qc.y.to_numpy()-corrected)))
                enabled=candidate_mae < original_mae
                validation={'base_mae':original_mae,'candidate_mae':candidate_mae}
                if enabled:correction=fix.predict(ev[model.columns])
                q=finite_quantile(np.abs(qc.y.to_numpy()-(corrected if enabled else qc.point.to_numpy())),PLAN['alpha'])
            p=ev[['timestamp','building_id','y','point']].copy();p['baseline_point']=p.point
            p['point']=np.maximum(0,p.point.to_numpy()+correction);p['enabled']=enabled
            p['lower']=np.maximum(0,p.point-(q or 0));p['upper']=p.point+(q or 0)
            p['abstain']=q is None
            p['hit']=(p.y >= p.lower) & (p.y <= p.upper)
            p['interval_available']=q is not None
            # Missing initial interval is NOT presented as a calibrated zero-width interval.
            p.loc[~p.interval_available,['lower','upper']]=np.nan
            predictions.append(p)
            week={'building':target,'start':str(start),'end':str(ev.timestamp.max()),'fit_n':len(fit),'cal_n':len(qc),
                'fit_end':str(fit.timestamp.max()) if len(fit) else None,'cal_end':str(qc.timestamp.max()) if len(qc) else None,
                'enabled':enabled,'validation':validation,'q':q,'n':len(ev)}
            week_rows.append(week)
        p=pd.concat(predictions,ignore_index=True)
        baseerr=p.y-p.baseline_point;err=p.y-p.point
        bm=float(baseerr.abs().mean());cm=float(err.abs().mean())
        weekly=[]
        for enabled,g in p.groupby('enabled'):
            weekly.append({'enabled':bool(enabled),'n':len(g),'base_mae':float((g.y-g.baseline_point).abs().mean()),'candidate_mae':float((g.y-g.point).abs().mean())})
        valid=p[p.interval_available]
        row={'building':target,'n':len(p),'base_mae':bm,'candidate_mae':cm,'mae_gain':1-cm/bm,
            'base_rmse':float(np.sqrt(np.mean(baseerr**2))),'candidate_rmse':float(np.sqrt(np.mean(err**2))),
            'enabled_fraction':float(p.enabled.mean()),'enabled_weeks':sum(w['enabled'] for w in week_rows),'total_weeks':len(week_rows),
            'by_enabled':weekly,'coverage_available':float(valid.hit.mean()) if len(valid) else None,
            'interval_available_n':len(valid),'source_buildings':11,'source_train_end':str(train.timestamp.max()),'source_cal_end':str(cal.timestamp.max()),
            'target_first_observed':str(first),'evaluation_start':str(p.timestamp.min()),'evaluation_end':str(p.timestamp.max()),'seconds':time.monotonic()-t0}
        rows.append(row);receipts.append(cache('cold_'+target,p))
        event('cold',**row)
        event('cold',building=target,weekly_updates=week_rows)
    result={'status':'completed','input_sha256':sha(path),'by_building':rows,'predictions':receipts,
        'macro_mae_gain':float(np.mean([r['mae_gain'] for r in rows])),
        'buildings_improved':sum(r['mae_gain']>0 for r in rows),'buildings':len(rows),
        'fit_selection':'source target disjoint; weekly target fit followed by later calibration slice, enables only if slice MAE improves',
        'cold_start_limit':'first 168 target hours warm-up; first scored week no correction; no future warm-up or source refit'}
    save('cold',result);event('cold',status='completed',macro_mae_gain=result['macro_mae_gain'])
def main():
    parser=argparse.ArgumentParser();parser.add_argument('stage',choices=['byron','six','cold'])
    stage=parser.parse_args().stage
    if (OUT/(stage+'_results.json')).exists() or (OUT/(stage+'_log.txt')).exists():
        raise FileExistsError('Versioned results immutable; choose a new experiment version')
    CACHE.mkdir(parents=True,exist_ok=True)
    t0=time.monotonic();event(stage,status='started',plan_sha256=sha(OUT/'plan.json'))
    with threadpool_limits(limits=1):
        {'byron':byron,'six':six,'cold':cold}[stage]()
    event(stage,status='finished',elapsed_seconds=time.monotonic()-t0)


if __name__=='__main__':main()
