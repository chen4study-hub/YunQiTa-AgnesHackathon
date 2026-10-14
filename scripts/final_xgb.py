"""One preregistered final XGBoost assessment. Never promotes or alters replay."""
import copy
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from xgboost import XGBRegressor
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run, summary
from scripts.point_search import score


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    artifact=Path('models/byron2017-xgb-v1.joblib')
    report=Path('experiments/xgb_final_assessment.json')
    if artifact.exists() or report.exists():
        raise FileExistsError('Immutable final assessment exists; do not re-evaluate or overwrite.')
    plan_path=Path('experiments/xgb_final_plan.json')
    plan=json.loads(plan_path.read_text(encoding='utf-8'))
    cfg=config('configs/byron2017_xgb.yaml')
    assert cfg['model']['version']==plan['candidate']
    for k,v in plan['point_parameters'].items():
        assert (cfg['seed'] if k=='seed' else cfg['model'][k])==v
    assert cfg['conformal']['rejection_fraction']==plan['rejection_fraction']
    data_path=Path('data/byron2017.csv')
    frame=adapt(pd.read_csv(data_path),cfg)
    times=sorted(frame.timestamp.unique());a=int(len(times)*.65);b=int(len(times)*.85)
    train=frame[frame.timestamp.isin(times[:a])];cal=frame[frame.timestamp.isin(times[a:b])]
    baseline_cfg=copy.deepcopy(cfg);baseline_cfg['model']['kind']='residual_lightgbm'
    baseline_cfg['model']['version']='byron2017-lgb-comparator-rho15'
    baseline=ResidualForecaster(baseline_cfg).fit(train,cal)
    candidate=copy.deepcopy(baseline);candidate.cfg=copy.deepcopy(cfg)
    f,_=candidate._matrix(train)
    kw=cfg['model']
    candidate.point_model=XGBRegressor(n_estimators=kw['n_estimators'],
        learning_rate=kw['learning_rate'],max_depth=kw['max_depth'],
        tree_method=kw['tree_method'],n_jobs=2,random_state=cfg['seed'],objective='reg:squarederror')
    candidate.point_model.fit(f[candidate.columns],f.y-f.lag_1)
    error=abs(f.y.to_numpy()-candidate._point(f));r=f.assign(error=error)
    candidate.global_risk=float(np.mean(error))
    candidate.building_risk=r.groupby('building_id').error.mean().to_dict()
    candidate.usage_risk=r.groupby('usage').error.mean().to_dict()
    candidate.train_history=train.groupby('building_id',sort=False).tail(max(cfg['features']['lags'])+1)
    candidate.recalibrate(cal,fit_scale=True);del candidate.train_history
    ct=times[a:b];cq_times=ct[int(len(ct)*cfg['conformal']['scale_fraction']):]
    rows=[];cache={}
    for name,model in [('lightgbm',baseline),('xgboost',candidate)]:
        f=primitives(model,frame)
        cq=f[f.timestamp.isin(cq_times)]
        test=f[f.timestamp.isin(times[b:])].sort_values('timestamp')
        pred=run(model,cq,test,plan['rejection_fraction'],'static')
        diag=score(pred,name,0);diag['split']='final_test_diagnostic'
        rows.append(dict(model=name,fixed_gate=summary(pred),same_budget_diagnostic=diag))
        pred.to_csv(f'data/byron_final_{name}_rho15.csv',index=False)
        cache[name]=dict(model=model,calibration=cq)
    bundle=dict(version=cfg['model']['version'],backbone=candidate,
        calibration=cache['xgboost']['calibration'],baseline=baseline,
        plan_sha256=sha(plan_path),data_sha256=sha(data_path),test_start=str(times[b]))
    joblib.dump(bundle,artifact)
    result=dict(status='completed',seed=42,plan=plan,plan_sha256=sha(plan_path),
        data_sha256=sha(data_path),config_sha256=sha('configs/byron2017_xgb.yaml'),
        artifact=str(artifact),artifact_sha256=sha(artifact),
        prediction_sha256={n:sha(f'data/byron_final_{n}_rho15.csv') for n in cache},
        rows=rows,champion_updated=False,replay_updated=False,
        coverage_target=.905,coverage_pass=rows[1]['fixed_gate']['retained_picp']>=.905,
        warning='Budget ranking uses final risk ordering, not deployable thresholds. No test-driven retuning.')
    report.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2),flush=True)


if __name__=='__main__':main()
