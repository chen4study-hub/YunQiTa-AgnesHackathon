"""Bounded development-window trade-off study. Never reads final test rows for fitting/evaluation."""
import copy
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import pandas as pd
from xgboost import XGBRegressor
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run, summary
from scripts.search_byron import fit_quantiles
from src.conformal.rolling_cqr import run_rolling_cqr


def interval_score(pred, alpha):
    width=pred.upper-pred.lower
    return width+2/alpha*(np.maximum(pred.lower-pred.y,0)+np.maximum(pred.y-pred.upper,0))


def xgb_model(proto, train, cal, cfg):
    model=copy.deepcopy(proto);model.cfg=copy.deepcopy(cfg)
    f,_=model._matrix(train);kw=cfg['model']
    model.point_model=XGBRegressor(n_estimators=kw['n_estimators'],learning_rate=kw['learning_rate'],
        max_depth=kw['max_depth'],tree_method=kw['tree_method'],n_jobs=2,
        random_state=cfg['seed'],objective='reg:squarederror')
    model.point_model.fit(f[model.columns],f.y-f.lag_1)
    err=abs(f.y.to_numpy()-model._point(f));r=f.assign(error=err)
    model.global_risk=float(np.mean(err));model.building_risk=r.groupby('building_id').error.mean().to_dict()
    model.usage_risk=r.groupby('usage').error.mean().to_dict()
    model.train_history=train.groupby('building_id',sort=False).tail(max(cfg['features']['lags'])+1)
    model.recalibrate(cal,fit_scale=True);del model.train_history
    return model


def main(rolling_cqr=False):
    stem='rolling_cqr_research' if rolling_cqr else 'composite_research'
    out=Path(f'experiments/{stem}.json')
    if out.exists(): raise FileExistsError('Preserve the original development study; version further changes.')
    plan_path=Path('experiments/composite_research_plan.json')
    plan=json.loads(plan_path.read_text(encoding='utf-8'))
    cfg=config('configs/byron2017_xgb.yaml')
    source=Path('data/byron2017.csv')
    raw=pd.read_csv(source)
    # Restrict rows before building feature matrices, so final test labels cannot influence this study.
    timestamps=sorted(raw.timestamp.unique());development=raw[raw.timestamp.isin(timestamps[:int(len(timestamps)*.65)])]
    frame=adapt(development,cfg)
    all_times=pd.to_datetime(timestamps,utc=True)
    rows=[]
    for fold,bounds in enumerate(plan['development_folds'],1):
        a,b,c=[int(len(timestamps)*v) for v in bounds]
        train=frame[frame.timestamp.isin(all_times[:a])]
        cal=frame[frame.timestamp.isin(all_times[a:b])]
        start=time.perf_counter()
        lcfg=copy.deepcopy(cfg);lcfg['model']['kind']='residual_lightgbm'
        lgb=ResidualForecaster(lcfg).fit(train,cal)
        lgb_fit=time.perf_counter()-start
        start=time.perf_counter();xgb=None if rolling_cqr else xgb_model(lgb,train,cal,cfg);xgb_fit=time.perf_counter()-start
        start=time.perf_counter();qmodels=fit_quantiles(lgb,train);qfit=time.perf_counter()-start
        models={'lgb':lgb,'xgb':xgb}
        variants=[('lgb_cqr','lgb','cqr'),('lgb_static','lgb','static'),
                  ('xgb_static','xgb','static'),('xgb_rolling2w','xgb','rolling')]
        if rolling_cqr:
            variants=[('lgb_cqr','lgb','cqr'),('lgb_cqr_rolling2w','lgb','rolling_cqr')]
        for name,backend,method in variants:
            start=time.perf_counter();model=models[backend]
            f=primitives(model,frame[frame.timestamp.isin(all_times[:c])])
            ct=all_times[a:b];cq=f[f.timestamp.isin(ct[int(len(ct)*cfg['conformal']['scale_fraction']):])]
            evaluation=f[f.timestamp.isin(all_times[b:c])].sort_values('timestamp')
            if method=='rolling_cqr':
                pred=run_rolling_cqr(model,cq,evaluation,plan['rejection_fraction'],qmodels,weeks=plan['rolling_weeks'])
            else:
                pred=run(model,cq,evaluation,plan['rejection_fraction'],method,
                         weeks=plan['rolling_weeks'],quantile_models=qmodels if method=='cqr' else None)
            stats=summary(pred)
            stats.update(interval_score=float(interval_score(pred,plan['alpha']).mean()),
                         all_picp=float(pred.hit.mean()),point_std=float(pred.point.std()),
                         risk_unique=int(pred.risk_score.nunique()),
                         seconds=(lgb_fit if backend=='lgb' else xgb_fit)+(qfit if method in ('cqr','rolling_cqr') else 0)+time.perf_counter()-start)
            assert np.isfinite(list(stats.values())).all()
            assert pred.timestamp.max()<all_times[int(len(timestamps)*.65)]
            rows.append(dict(fold=fold,method=name,start=str(pred.timestamp.min()),end=str(pred.timestamp.max()),**stats))
    table=pd.DataFrame(rows)
    for fold in table.fold.unique():
        idx=table.fold.eq(fold);base=table[idx & table.method.eq('lgb_cqr')].iloc[0]
        for i,row in table[idx].iterrows():
            terms=np.array([row.mae/base.mae,row.interval_score/base.interval_score,
                (1+row.rejection_rate)/(1+base.rejection_rate),
                1+max(0,1-plan['alpha']-row.retained_picp)/plan['alpha']])
            for label,weights in plan['weight_sensitivity'].items():
                table.loc[i,'composite_'+label]=float(np.dot(terms,weights))
    table.to_csv(f'experiments/{stem}.csv',index=False)
    aggregate=table.groupby('method')[['mae','interval_score','retained_picp','rejection_rate','width','seconds',
        'composite_balanced','composite_error_priority','composite_coverage_priority']].mean()
    result=dict(status='completed_development_only',plan_sha256=hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        data_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        development_end=str(frame.timestamp.max()),aggregate=aggregate.to_dict(orient='index'),
        winners={label:aggregate['composite_'+label].idxmin() for label in plan['weight_sensitivity']},
        folds=rows,champion_updated=False,replay_updated=False,
        caveats=plan['caveats'],metric_direction='all composites smaller is better; fold means, not independent samples')
    if rolling_cqr:
        result['followup_plan_sha256']=hashlib.sha256(Path('experiments/rolling_cqr_plan.json').read_bytes()).hexdigest()
    out.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2),flush=True)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--rolling-cqr',action='store_true')
    main(parser.parse_args().rolling_cqr)
