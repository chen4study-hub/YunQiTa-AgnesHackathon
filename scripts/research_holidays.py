"""True historical expansion and calendar ablation; no holiday duplication."""
import copy
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run, summary
from scripts.search_byron import fit_quantiles
from scripts.research_multibuilding_ood import losses


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def metrics(pred):
    s=summary(pred) if (~pred.abstain).any() else dict(n=len(pred),retained_n=0,rejection_rate=1.,retained_picp=None,
        retained_mae=None,mae=float(abs(pred.y-pred.point).mean()),rmse=float(np.sqrt(np.mean((pred.y-pred.point)**2))),width=None)
    s['interval_score']=float((pred.upper-pred.lower+2/.095*(np.maximum(pred.lower-pred.y,0)+np.maximum(pred.y-pred.upper,0))).mean())
    s['unique_days']=int(pred.timestamp.dt.strftime('%Y-%m-%d').nunique())
    return s


def main():
    receipt=Path('experiments/holiday_expansion_results.json')
    if receipt.exists():raise FileExistsError('Do not overwrite experiment')
    plan_path=Path('experiments/holiday_expansion_plan.json');plan=json.loads(plan_path.read_text(encoding='utf-8'))
    root=Path('data/raw/bdg2')
    matrix=pd.read_csv(root/'electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    matrix=matrix.rename(columns={'Hog_office_Byron':'meter_reading'})
    matrix=matrix[matrix.timestamp>='2016-01-20 00:00:00'].copy()
    assert not matrix.meter_reading.isna().any()
    matrix['building_id']='Hog_office_Byron';matrix['primary_use']='Office'
    weather=pd.read_csv(root/'weather.csv',usecols=['timestamp','site_id','airTemperature'])
    weather=weather[weather.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature'})
    data=matrix.merge(weather[['timestamp','air_temperature']],on='timestamp',how='left',validate='one_to_one')
    data['timestamp']=pd.to_datetime(data.timestamp,utc=True)
    cfg=config('configs/byron2017.yaml');cfg=copy.deepcopy(cfg);cfg['conformal']['rejection_fraction']=.15
    frame=adapt(data,cfg)
    dates=USFederalHolidayCalendar().holidays('2016-01-01','2017-12-31').strftime('%Y-%m-%d').tolist()
    times=sorted(frame[frame.timestamp.dt.year.eq(2017)].timestamp.unique())
    # Never expose final2017 test rows to feature-building or evaluation here.
    frame=frame[frame.timestamp<pd.Timestamp(times[int(len(times)*.85)])]
    clean=Path('data/byron2016_2017_holiday_development.csv');frame.to_csv(clean,index=False)
    rows=[];kept=[]
    weights=json.loads(Path('experiments/composite_research_plan.json').read_text(encoding='utf-8'))['weight_sensitivity']
    for fold,bounds in enumerate(plan['folds_2017'],1):
        a,b,c=[int(len(times)*v) for v in bounds]
        cal=frame[frame.timestamp.isin(times[a:b])]
        base_stats=None;base_holiday=None
        for variant in plan['variants']:
            expanded=variant.startswith('expanded');calendar=variant.endswith('holiday_flag')
            local_cfg=copy.deepcopy(cfg);local_cfg['features']['holidays']=dates if calendar else []
            train=frame[frame.timestamp<pd.Timestamp(times[a])]
            if not expanded:train=train[train.timestamp.dt.year.eq(2017)]
            model=ResidualForecaster(local_cfg).fit(train,cal);q=fit_quantiles(model,train)
            f=primitives(model,frame[frame.timestamp<pd.Timestamp(times[c])]);ct=times[a:b]
            cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
            ev=f[f.timestamp.isin(times[b:c])].sort_values('timestamp')
            pred=run(model,cq,ev,.15,'cqr',quantile_models=q)
            pred['holiday']=pred.timestamp.dt.strftime('%Y-%m-%d').isin(dates)
            overall=metrics(pred);holiday=metrics(pred[pred.holiday]);ordinary=metrics(pred[~pred.holiday])
            tf,_=model._matrix(train)
            training_holiday_dates=sorted(set(tf.timestamp.dt.strftime('%Y-%m-%d'))&set(dates))
            if base_stats is None:base_stats=overall;base_holiday=holiday
            bl=losses(base_stats,base_stats,weights);cl=losses(overall,base_stats,weights)
            gains={label:1-cl[label]/bl[label] for label in weights}
            hg=1-holiday['mae']/base_holiday['mae']
            row=dict(fold=fold,variant=variant,training_rows=len(train),usable_training_rows=len(tf),
                training_holiday_dates=training_holiday_dates,training_holiday_days=len(training_holiday_dates),
                overall=overall,holiday=holiday,ordinary=ordinary,composite_gain=gains,holiday_mae_gain=hg)
            rows.append(row)
            if variant!=plan['variants'][0] and (any(g>1e-10 for g in gains.values()) or hg>1e-10):
                tag=f'holiday_expansion_f{fold}_{variant}';artifact=Path('models')/(tag+'.joblib');cache=Path('data')/(tag+'.csv')
                if artifact.exists() or cache.exists():raise FileExistsError('Preserve intermediate')
                joblib.dump(dict(version=tag,backbone=model,quantile_models=q,calibration=cq,
                    holiday_dates=dates,training_holiday_dates=training_holiday_dates,
                    plan_sha256=sha(plan_path),data_sha256=sha(clean),shadow=True),artifact)
                pred.to_csv(cache,index=False)
                kept.append(dict(fold=fold,variant=variant,artifact=str(artifact),artifact_sha256=sha(artifact),
                    predictions=str(cache),predictions_sha256=sha(cache),composite_gain=gains,holiday_mae_gain=hg))
            print(json.dumps({'fold':fold,'variant':variant,'train_holiday_days':len(training_holiday_dates),
                'holiday_mae':holiday['mae'],'overall_mae':overall['mae'],'gains':gains}),flush=True)
    aggregates={v:dict(holiday_mae=float(np.mean([r['holiday']['mae'] for r in rows if r['variant']==v])),
        overall_mae=float(np.mean([r['overall']['mae'] for r in rows if r['variant']==v])),
        composite_gain={k:float(np.mean([r['composite_gain'][k] for r in rows if r['variant']==v])) for k in weights})
        for v in plan['variants']}
    result=dict(status='exploratory_complete',plan_sha256=sha(plan_path),clean_data=str(clean),clean_data_sha256=sha(clean),
        calendar_dates=dates,rows=rows,aggregate=aggregates,intermediates=kept,
        final_test_evaluated=False,champion_updated=False,replay_updated=False,
        limitations=plan['limits'])
    receipt.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(aggregates,indent=2),flush=True)


if __name__=='__main__':main()
