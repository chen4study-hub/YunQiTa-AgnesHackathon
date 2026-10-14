"""Fixed recency-weighted LightGBM+CQR study on development rows only."""
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run, summary
from scripts.search_byron import fit_quantiles


def recency_weights(timestamps,half_life_weeks):
    if half_life_weeks<=0:raise ValueError('positive half-life required')
    age=(timestamps.max()-timestamps).dt.total_seconds()/604800.
    return np.exp2(-age.to_numpy()/half_life_weeks)


def main():
    receipt=Path('experiments/recency_research.json')
    if receipt.exists():raise FileExistsError('Use a new version for further research')
    plan_path=Path('experiments/recency_plan.json');plan=json.loads(plan_path.read_text(encoding='utf-8'))
    cfg=config('configs/byron2017.yaml');cfg=copy.deepcopy(cfg);cfg['conformal']['rejection_fraction']=.15
    raw=pd.read_csv('data/byron2017.csv');times=sorted(raw.timestamp.unique());ts=pd.to_datetime(times,utc=True)
    raw=raw[raw.timestamp.isin(times[:int(len(times)*.65)])]
    data=adapt(raw,cfg);rows=[]
    options=dict(n_estimators=cfg['model']['n_estimators'],learning_rate=cfg['model']['learning_rate'],
        num_leaves=cfg['model']['num_leaves'],random_state=cfg['seed'],verbosity=-1,n_jobs=2)
    for fold,bounds in enumerate(plan['folds'],1):
        a,b,c=[int(len(times)*v) for v in bounds]
        train=data[data.timestamp.isin(ts[:a])];cal=data[data.timestamp.isin(ts[a:b])]
        baseline=ResidualForecaster(cfg).fit(train,cal)
        candidate=copy.deepcopy(baseline);f,_=candidate._matrix(train)
        weights=recency_weights(f.timestamp,plan['half_life_weeks'])
        candidate.point_model=LGBMRegressor(**options)
        candidate.point_model.fit(f[candidate.columns],f.y-f.lag_1,sample_weight=weights)
        error=abs(f.y.to_numpy()-candidate._point(f));r=f.assign(error=error)
        candidate.global_risk=float(np.mean(error));candidate.building_risk=r.groupby('building_id').error.mean().to_dict()
        candidate.usage_risk=r.groupby('usage').error.mean().to_dict()
        candidate.train_history=train.groupby('building_id',sort=False).tail(max(cfg['features']['lags'])+1)
        candidate.recalibrate(cal,fit_scale=True);del candidate.train_history
        qbase=fit_quantiles(baseline,train)
        qcandidate=[]
        for alpha in (cfg['conformal']['alpha']/2,1-cfg['conformal']['alpha']/2):
            q=LGBMRegressor(objective='quantile',alpha=alpha,**options)
            q.fit(f[candidate.columns],f.y-f.lag_1,sample_weight=weights);qcandidate.append(q)
        for name,model,qmodels in [('lgb_cqr',baseline,qbase),('lgb_recency8w_cqr',candidate,qcandidate)]:
            f=primitives(model,data[data.timestamp.isin(ts[:c])]);ct=ts[a:b]
            cq=f[f.timestamp.isin(ct[int(len(ct)*cfg['conformal']['scale_fraction']):])]
            ev=f[f.timestamp.isin(ts[b:c])].sort_values('timestamp')
            pred=run(model,cq,ev,.15,'cqr',quantile_models=qmodels)
            s=summary(pred);alpha=cfg['conformal']['alpha']
            s['interval_score']=float((pred.upper-pred.lower+2/alpha*(np.maximum(pred.lower-pred.y,0)+np.maximum(pred.y-pred.upper,0))).mean())
            s['effective_training_n']=float(weights.sum()**2/np.square(weights).sum()) if name!='lgb_cqr' else len(weights)
            rows.append(dict(fold=fold,method=name,**s))
    table=pd.DataFrame(rows)
    policy=json.loads(Path('experiments/composite_research_plan.json').read_text(encoding='utf-8'))
    for fold in table.fold.unique():
        base=table[(table.fold==fold)&(table.method=='lgb_cqr')].iloc[0]
        for i,row in table[table.fold==fold].iterrows():
            terms=[row.mae/base.mae,row.interval_score/base.interval_score,
                (1+row.rejection_rate)/(1+base.rejection_rate),1+max(0,.905-row.retained_picp)/.095]
            for label,w in policy['weight_sensitivity'].items():table.loc[i,'composite_'+label]=float(np.dot(terms,w))
    table.to_csv('experiments/recency_research.csv',index=False)
    agg=table.groupby('method').mean(numeric_only=True).drop(columns='fold')
    result=dict(status='development_only',plan_sha256=hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        aggregate=agg.to_dict(orient='index'),folds=rows,
        winners={label:agg['composite_'+label].idxmin() for label in policy['weight_sensitivity']},
        final_test_evaluated=False,champion_updated=False,replay_updated=False)
    receipt.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))


if __name__=='__main__':main()
