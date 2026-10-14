"""Diagnose seasonal extrapolation and test fixed residual shrinkage on development windows."""
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.models.shrinkage import ScaledResidual, WeatherOODResidual
from src.conformal.replay_calibration import primitives, run, summary
from scripts.search_byron import fit_quantiles
from scripts.research_composite import xgb_model, interval_score


def recalibrate_point(model,train,cal):
    f,_=model._matrix(train);error=abs(f.y.to_numpy()-model._point(f));r=f.assign(error=error)
    model.global_risk=float(np.mean(error));model.building_risk=r.groupby('building_id').error.mean().to_dict()
    model.usage_risk=r.groupby('usage').error.mean().to_dict()
    model.train_history=train.groupby('building_id',sort=False).tail(max(model.cfg['features']['lags'])+1)
    model.recalibrate(cal,fit_scale=True);del model.train_history


def main(weather_ood=False):
    stem='weather_ood' if weather_ood else 'deep_drift'
    out=Path(f'experiments/{stem}_research.json')
    if out.exists():raise FileExistsError('Existing experiment is immutable')
    plan_path=Path('experiments/deep_drift_plan.json');plan=json.loads(plan_path.read_text(encoding='utf-8'))
    cfg=config('configs/byron2017_xgb.yaml')
    raw=pd.read_csv('data/byron2017.csv');times=sorted(raw.timestamp.unique());ts=pd.to_datetime(times,utc=True)
    data=adapt(raw[raw.timestamp.isin(times[:int(len(times)*.65)])],cfg)
    rows=[];diagnostics=[]
    for fold,bounds in enumerate(plan['folds'],1):
        a,b,c=[int(len(times)*v) for v in bounds]
        train=data[data.timestamp.isin(ts[:a])];cal=data[data.timestamp.isin(ts[a:b])]
        lcfg=copy.deepcopy(cfg);lcfg['model']['kind']='residual_lightgbm'
        baseline=ResidualForecaster(lcfg).fit(train,cal)
        xgb=xgb_model(baseline,train,cal,cfg)
        shrink=copy.deepcopy(baseline)
        training_features,_=baseline._matrix(train)
        weather_column='air_temperature_past'
        lo=float(training_features[weather_column].min());hi=float(training_features[weather_column].max())
        def wrap(q):
            return WeatherOODResidual(q,weather_column,lo,hi,plan['shrinkage']) if weather_ood else ScaledResidual(q,plan['shrinkage'])
        shrink.point_model=wrap(shrink.point_model)
        recalibrate_point(shrink,train,cal)
        qbase=fit_quantiles(baseline,train)
        qshrink=tuple(wrap(q) for q in qbase)
        tf,_=baseline._matrix(train)
        bf=primitives(baseline,data[data.timestamp.isin(ts[:c])]);ev=bf[bf.timestamp.isin(ts[b:c])].copy()
        xf=primitives(xgb,data[data.timestamp.isin(ts[:c])]);xe=xf[xf.timestamp.isin(ts[b:c])]
        assert ev.timestamp.to_list()==xe.timestamp.to_list()
        ev['lgb_error']=abs(ev.y-ev.point)
        ev['xgb_error']=abs(ev.y.to_numpy()-xe.point.to_numpy())
        ev['persistence_error']=abs(ev.y-ev.lag_1)
        weather='air_temperature_past'
        ev['weather_ood']=(ev[weather]<tf[weather].min())|(ev[weather]>tf[weather].max())
        ev['load_ood']=(ev.lag_1<tf.lag_1.min())|(ev.lag_1>tf.lag_1.max())
        ev['high_disagreement']=ev.disagreement>tf.disagreement.quantile(.9)
        ev['large_target_jump']=abs(ev.y-ev.lag_1)>abs(tf.y-tf.lag_1).quantile(.9)
        for flag in ('weather_ood','load_ood','high_disagreement','large_target_jump'):
            for state,g in ev.groupby(flag):
                diagnostics.append(dict(fold=fold,flag=flag,state=bool(state),n=len(g),
                    fraction=len(g)/len(ev),lgb_mae=float(g.lgb_error.mean()),
                    xgb_mae=float(g.xgb_error.mean()),persistence_mae=float(g.persistence_error.mean()),
                    deployable_flag=flag!='large_target_jump'))
        for name,model,q in [('lgb_cqr',baseline,qbase),('lgb_weather_ood_cqr' if weather_ood else 'lgb_half_residual_cqr',shrink,qshrink)]:
            f=primitives(model,data[data.timestamp.isin(ts[:c])]);ct=ts[a:b]
            cq=f[f.timestamp.isin(ct[int(len(ct)*cfg['conformal']['scale_fraction']):])]
            e=f[f.timestamp.isin(ts[b:c])].sort_values('timestamp')
            pred=run(model,cq,e,.15,'cqr',quantile_models=q)
            s=summary(pred);s['interval_score']=float(interval_score(pred,.095).mean())
            s['point_std']=float(pred.point.std());rows.append(dict(fold=fold,method=name,**s))
    table=pd.DataFrame(rows)
    policy=json.loads(Path('experiments/composite_research_plan.json').read_text(encoding='utf-8'))
    for fold in table.fold.unique():
        base=table[(table.fold==fold)&(table.method=='lgb_cqr')].iloc[0]
        for i,row in table[table.fold==fold].iterrows():
            terms=[row.mae/base.mae,row.interval_score/base.interval_score,
                   (1+row.rejection_rate)/(1+base.rejection_rate),1+max(0,.905-row.retained_picp)/.095]
            for label,w in policy['weight_sensitivity'].items():table.loc[i,'composite_'+label]=float(np.dot(terms,w))
    table.to_csv(f'experiments/{stem}_candidates.csv',index=False)
    pd.DataFrame(diagnostics).to_csv(f'experiments/{stem}_diagnostics.csv',index=False)
    agg=table.groupby('method').mean(numeric_only=True).drop(columns='fold')
    result=dict(status='development_only',plan_sha256=hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        aggregate=agg.to_dict(orient='index'),diagnostics=diagnostics,folds=rows,
        winners={label:agg['composite_'+label].idxmin() for label in policy['weight_sensitivity']},
        final_test_evaluated=False,champion_updated=False,replay_updated=False)
    if weather_ood:
        result['followup_plan_sha256']=hashlib.sha256(Path('experiments/weather_ood_plan.json').read_bytes()).hexdigest()
    out.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--weather-ood',action='store_true')
    main(parser.parse_args().weather_ood)
