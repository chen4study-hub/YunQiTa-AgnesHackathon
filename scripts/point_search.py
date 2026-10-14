"""Low-priority tree point-model screen on pilot validation only. No test/promotions."""
import copy
import json
import time
from pathlib import Path
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from scipy.stats import binomtest
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run


def score(pred, name, elapsed):
    # Budget-matched comparison: same NUMBER of risk-ranked retained rows.
    # Calibration-fixed gate stats are recorded separately; validation rank is diagnostic.
    n=int(len(pred)*.85)
    kept=pred.sort_values('risk_score',kind='stable').iloc[:n]
    ci=binomtest(int(kept.hit.sum()),n).proportion_ci(method='exact')
    return dict(model=name,split='validation_only',seed=42,elapsed_seconds=elapsed,
        actual_gate_rejection=float(pred.abstain.mean()),
        gate_retained_picp=float(pred.loc[~pred.abstain,'hit'].mean()),
        gate_retained_mae=float(abs(pred.loc[~pred.abstain,'y']-pred.loc[~pred.abstain,'point']).mean()),
        budget_rank_retained_n=n,budget_rank_retained_picp=float(kept.hit.mean()),
        budget_rank_retained_mae=float(abs(kept.y-kept.point).mean()),
        budget_rank_ci_low=float(ci.low),budget_rank_ci_high=float(ci.high),
        eligible_for_champion=False)


def main():
    cfg=config('configs/byron2017.yaml');frame=adapt(pd.read_csv('data/byron2017.csv'),cfg)
    times=sorted(frame.timestamp.unique());p,q,a=[int(len(times)*v) for v in (.45,.55,.65)]
    train=frame[frame.timestamp.isin(times[:p])];cal=frame[frame.timestamp.isin(times[p:q])]
    proto=ResidualForecaster(cfg).fit(train,cal)
    training,_=proto._matrix(train)
    target=training.y-training.lag_1
    rows=[]
    for backend in ('lightgbm','xgboost','catboost'):
        start=time.monotonic()
        model=copy.deepcopy(proto)
        if backend=='xgboost':
            from xgboost import XGBRegressor
            model.point_model=XGBRegressor(n_estimators=150,learning_rate=.05,max_depth=5,
                n_jobs=2,random_state=42,objective='reg:squarederror',tree_method='hist')
            model.point_model.fit(training[model.columns],target)
        elif backend=='catboost':
            from catboost import CatBoostRegressor
            model.point_model=CatBoostRegressor(iterations=150,learning_rate=.05,depth=5,
                random_seed=42,thread_count=2,verbose=False,allow_writing_files=False)
            model.point_model.fit(training[model.columns],target)
        if backend!='lightgbm':
            error=abs(training.y.to_numpy()-model._point(training))
            r=training.assign(error=error)
            model.global_risk=float(np.mean(error))
            model.building_risk=r.groupby('building_id').error.mean().to_dict()
            model.usage_risk=r.groupby('usage').error.mean().to_dict()
            model.train_history=train.groupby('building_id').tail(169)
            model.recalibrate(cal,fit_scale=True);del model.train_history
        f=primitives(model,frame[frame.timestamp.isin(times[:a])])
        ct=times[p:q];cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
        valid=f[f.timestamp.isin(times[q:a])].sort_values('timestamp')
        pred=run(model,cq,valid,.15,'static')
        rows.append(score(pred,backend,time.monotonic()-start))
        print(json.dumps(rows[-1]),flush=True)
    out=Path('experiments/point_validation_screen.csv')
    pd.DataFrame(rows).to_csv(out,index=False)
    print('No final test labels used in fitting, selection, or metrics. No artifacts/champion/replay changed.',flush=True)


if __name__=='__main__':main()
