"""Single frozen monthly evaluation; caches/models checkpointed, no demo champion promotion."""
import hashlib
import json
import time
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scripts.research_holiday_calibration import load_data
from scripts.prepare_demo_monthly import fit_confidence
from src.models.direct_multi import features,fit_month,predict

PLAN=Path('experiments/multi_horizon_v1_plan.json')
INDEX=Path('experiments/multi_horizon_v1_index.json')


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def summarize(frame):
    observed=frame[frame.y.notna()];kept=observed[~observed.abstain]
    return dict(n=len(observed),issued_n=len(frame),retained_n=len(kept),retained_coverage=float(kept.hit.mean()),
        all_coverage=float(observed.hit.mean()),rejection_rate=float(observed.abstain.mean()),
        mae=float(np.abs(observed.y-observed.point).mean()),retained_mae=float(np.abs(kept.y-kept.point).mean()),
        persistence_mae=float(np.abs(observed.y-observed.load_t).mean()),
        retained_width=float((kept.upper-kept.lower).mean()))


def main():
    if INDEX.exists():raise FileExistsError('Completed evaluation immutable, do not rerun')
    plan=json.loads(PLAN.read_text());plan_hash=sha(PLAN);data=load_data();frame=features(data);past=[];rows=[];start_run=time.monotonic()
    cache_root=Path('data/direct24');cache_root.mkdir(exist_ok=True)
    for start in pd.date_range('2016-12-01','2017-12-01',freq='MS',tz='UTC'):
        month=start.strftime('%Y-%m');artifact=Path(f'models/{plan["version"]}-{month}.joblib');cache=cache_root/f'{month}.csv';receipt=cache_root/f'{month}.json'
        if receipt.exists():
            r=json.loads(receipt.read_text());assert r['plan_sha256']==plan_hash and sha(cache)==r['predictions_sha256'] and sha(artifact)==r['artifact_sha256']
            pred=pd.read_csv(cache,parse_dates=['origin','target'])
        else:
            if artifact.exists() or cache.exists():raise FileExistsError('Incomplete artifact: inspect before restart')
            bundle=fit_month(frame,start,plan)
            evaluation=frame[(frame.origin>=start)&(frame.origin<start+pd.offsets.MonthBegin(1))]
            lookups=None;confidence_end=None
            if past:
                completed=pd.concat(past,ignore_index=True);completed=completed[(completed.target<start)&completed.y.notna()]
                assert completed.target.max()<start
                lookups={int(h):fit_confidence(g) for h,g in completed.groupby('horizon')};confidence_end=str(completed.target.max())
            pred=predict(bundle,evaluation,lookups)
            bundle['confidence_lookup']=lookups;bundle['confidence_validation_target_end']=confidence_end
            joblib.dump(bundle,artifact);pred.to_csv(cache,index=False)
            r=dict(month=month,artifact=str(artifact),predictions=str(cache),artifact_sha256=sha(artifact),predictions_sha256=sha(cache),plan_sha256=plan_hash,
                train_target_end=bundle['train_target_end'],scale_target_end=bundle['scale_target_end'],cq_target_end=bundle['cq_target_end'],
                confidence_validation_target_end=confidence_end,cq_hours_by_horizon={str(h):c['n'] for h,c in bundle['calibrations'].items()})
            receipt.write_text(json.dumps(r,indent=2),encoding='utf-8')
        past.append(pred)
        if start.year==2017:rows.append(r)
        print(json.dumps(dict(month=month,seconds=round(time.monotonic()-start_run,1))),flush=True)
    final=pd.concat([p for p in past if pd.to_datetime(p.origin,utc=True).dt.year.eq(2017).any()],ignore_index=True)
    metrics=[dict(horizon=int(h),**summarize(g)) for h,g in final.groupby('horizon')]
    pd.DataFrame(metrics).to_csv('experiments/multi_horizon_v1_metrics.csv',index=False)
    result=dict(status='completed',version=plan['version'],plan_sha256=plan_hash,rows=rows,metrics=metrics,
        parameters_retuned=False,legacy_model_changed=False,total_issued=len(final),total_observed=int(final.y.notna().sum()),
        code_sha256={p:sha(p) for p in ['src/models/direct_multi.py','scripts/backtest_direct24.py']})
    INDEX.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(metrics),flush=True)


if __name__=='__main__':main()
