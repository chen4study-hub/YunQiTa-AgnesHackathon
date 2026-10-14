"""Fixed multi-building portability check; retain every improving intermediate bundle."""
import copy
import hashlib
import json
import time
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.models.shrinkage import WeatherOODResidual
from src.conformal.replay_calibration import primitives, run, summary
from scripts.search_byron import fit_quantiles


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def losses(stats,base,weights):
    terms=[stats['mae']/max(base['mae'],1e-9),
           stats['interval_score']/max(base['interval_score'],1e-9),
           (1+stats['rejection_rate'])/(1+base['rejection_rate']),
           1+max(0,.905-stats['retained_picp'])/.095]
    return {label:float(np.dot(terms,w)) for label,w in weights.items()}


def main(point_only=False):
    stem='multibuilding_pointonly' if point_only else 'multibuilding_ood'
    result_path=Path(f'experiments/{stem}_results.json')
    if result_path.exists():raise FileExistsError('Results immutable; create a new version')
    plan_path=Path('experiments/multibuilding_ood_plan.json')
    plan=json.loads(plan_path.read_text(encoding='utf-8'))
    policy_path=Path('experiments/composite_research_plan.json')
    weights=json.loads(policy_path.read_text(encoding='utf-8'))['weight_sensitivity']
    cfg=config('configs/byron2017.yaml');cfg=copy.deepcopy(cfg);cfg['conformal']['rejection_fraction']=plan['rho']
    source=Path('data/hog2017_cohort.csv');raw=pd.read_csv(source)
    times=sorted(raw.timestamp.unique());ts=pd.to_datetime(times,utc=True)
    raw=raw[raw.timestamp.isin(times[:int(len(times)*.65)]) & raw.building_id.isin(plan['buildings'])]
    data=adapt(raw,cfg);rows=[];kept=[];failures=[];start=time.perf_counter()
    for building in plan['buildings']:
        one=data[data.building_id.eq(building)]
        for fold,bounds in enumerate(plan['folds'],1):
            a,b,c=[int(len(times)*v) for v in bounds]
            train=one[one.timestamp.isin(ts[:a])];cal=one[one.timestamp.isin(ts[a:b])]
            try:
                baseline=ResidualForecaster(cfg).fit(train,cal)
                trainf,_=baseline._matrix(train);col='air_temperature_past'
                lo=float(trainf[col].min());hi=float(trainf[col].max())
                def wrap(q):return WeatherOODResidual(q,col,lo,hi,plan['factor'])
                candidate=copy.deepcopy(baseline);candidate.point_model=wrap(candidate.point_model)
                f,_=candidate._matrix(train);err=abs(f.y.to_numpy()-candidate._point(f));r=f.assign(error=err)
                candidate.global_risk=float(np.mean(err));candidate.building_risk=r.groupby('building_id').error.mean().to_dict()
                candidate.usage_risk=r.groupby('usage').error.mean().to_dict()
                candidate.train_history=train.groupby('building_id',sort=False).tail(max(cfg['features']['lags'])+1)
                candidate.recalibrate(cal,fit_scale=True);del candidate.train_history
                qbase=fit_quantiles(baseline,train);qcandidate=tuple(wrap(q) for q in qbase)
                stats={};preds={};cqs={}
                for name,model,q in [('baseline',baseline,qbase),('weather_ood',candidate,qcandidate)]:
                    f=primitives(model,one[one.timestamp.isin(ts[:c])]);ct=ts[a:b]
                    cq=f[f.timestamp.isin(ct[int(len(ct)*cfg['conformal']['scale_fraction']):])]
                    ev=f[f.timestamp.isin(ts[b:c])].sort_values('timestamp')
                    pred=run(model,cq,ev,plan['rho'],'cqr',quantile_models=q)
                    s=summary(pred)
                    s['interval_score']=float((pred.upper-pred.lower+2/.095*(np.maximum(pred.lower-pred.y,0)+np.maximum(pred.y-pred.upper,0))).mean())
                    s['weather_ood_fraction']=float(((ev[col]<lo)|(ev[col]>hi)).mean())
                    s['weather_missing_fraction']=float(ev[col].isna().mean())
                    assert ev.timestamp.max()<ts[int(len(times)*.65)]
                    stats[name]=s;preds[name]=pred;cqs[name]=cq
                if point_only:
                    # Freeze baseline issued interval, confidence, risk, and abstention.
                    pred=preds['baseline'].copy()
                    frozen=preds['weather_ood'].point.to_numpy()
                    pred['point']=np.clip(frozen,pred.lower.to_numpy(),pred.upper.to_numpy())
                    s=summary(pred)
                    s['interval_score']=stats['baseline']['interval_score']
                    s['weather_ood_fraction']=stats['baseline']['weather_ood_fraction']
                    s['weather_missing_fraction']=stats['baseline']['weather_missing_fraction']
                    stats['weather_ood']=s;preds['weather_ood']=pred
                baseline_loss=losses(stats['baseline'],stats['baseline'],weights)
                candidate_loss=losses(stats['weather_ood'],stats['baseline'],weights)
                gains={k:1-candidate_loss[k]/baseline_loss[k] for k in weights}
                row=dict(building=building,fold=fold,baseline=stats['baseline'],candidate=stats['weather_ood'],
                    composite_gain=gains,baseline_loss=baseline_loss,candidate_loss=candidate_loss)
                rows.append(row)
                if any(g>1e-10 for g in gains.values()):
                    tag=f'{stem}_{building}_fold{fold}'
                    artifact=Path('models')/(tag+'.joblib');cache=Path('data')/(tag+'.csv')
                    if artifact.exists() or cache.exists():raise FileExistsError('Intermediate must not overwrite')
                    bundle=dict(version=tag,baseline=baseline,backbone=candidate,
                        quantile_models=qcandidate,baseline_quantile_models=qbase,
                        calibration=cqs['weather_ood'],baseline_calibration=cqs['baseline'],
                        weather_bounds=[lo,hi],plan_sha256=digest(plan_path),source_sha256=digest(source),
                        evaluation_start=str(preds['weather_ood'].timestamp.min()),
                        evaluation_end=str(preds['weather_ood'].timestamp.max()),shadow=True)
                    if point_only:
                        bundle.update(point_only=True,interval_backbone=baseline,
                            interval_quantile_models=qbase,interval_calibration=cqs['baseline'],
                            followup_plan_sha256=digest('experiments/multibuilding_pointonly_plan.json'))
                    joblib.dump(bundle,artifact)
                    pd.concat([p.assign(method=n) for n,p in preds.items()],ignore_index=True).to_csv(cache,index=False)
                    kept.append(dict(building=building,fold=fold,artifact=str(artifact),artifact_sha256=digest(artifact),
                        predictions=str(cache),predictions_sha256=digest(cache),composite_gain=gains,
                        exceeds_2pct_any=any(g>=.02 for g in gains.values()),
                        exceeds_2pct_all=all(g>=.02 for g in gains.values())))
                print(json.dumps({'building':building,'fold':fold,'gains':gains}),flush=True)
            except (ValueError,RuntimeError) as exc:
                failures.append(dict(building=building,fold=fold,error=str(exc)))
                print(json.dumps(failures[-1]),flush=True)
    flat=[]
    for r in rows:
        flat.append(dict(building=r['building'],fold=r['fold'],
            **{f'baseline_{k}':v for k,v in r['baseline'].items()},
            **{f'candidate_{k}':v for k,v in r['candidate'].items()},
            **{f'gain_{k}':v for k,v in r['composite_gain'].items()}))
    table=pd.DataFrame(flat);table.to_csv(f'experiments/{stem}_metrics.csv',index=False)
    macro={k:float(np.mean([r['composite_gain'][k] for r in rows])) for k in weights} if rows else {}
    per_building={building:{k:float(np.mean([r['composite_gain'][k] for r in rows if r['building']==building]))
        for k in weights} for building in plan['buildings'] if any(r['building']==building for r in rows)}
    result=dict(status='completed_exploratory',plan_sha256=digest(plan_path),policy_sha256=digest(policy_path),
        source_sha256=digest(source),completed_comparisons=len(rows),expected_comparisons=len(plan['buildings'])*len(plan['folds']),
        failures=failures,macro_composite_gain=macro,per_building_gain=per_building,
        global_2pct_pass=not failures and len(rows)==36 and all(g>=.02 for g in macro.values()),
        intermediates=kept,rows=rows,elapsed_seconds=time.perf_counter()-start,
        final_test_evaluated=False,champion_updated=False,replay_updated=False,
        caveats=plan['caveats'])
    if point_only:
        result['followup_plan_sha256']=digest('experiments/multibuilding_pointonly_plan.json')
    result_path.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'macro':macro,'kept':len(kept),'failures':failures,'global_2pct_pass':result['global_2pct_pass']}),flush=True)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--point-only',action='store_true')
    main(parser.parse_args().point_only)
