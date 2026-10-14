"""2016selection frozen on disk, then single2017evaluation; no retuning."""
import copy
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scripts.research_holiday_calibration import load_data
from scripts.backtest_direct24 import summarize,sha
from scripts.prepare_demo_monthly import fit_confidence
from scripts.monthly_backtest import split_month
from scripts.search_byron import fit_quantiles
from src.data.adapter import config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives
from src.models.direct_multi import features as v1_features,fit_month as v1_fit,predict as v1_predict
from src.models.shortfix_multi import features,fit_month,predict,one_step_at
from pandas.tseries.holiday import USFederalHolidayCalendar

PLAN=Path('experiments/multi_horizon_v2_plan.json');SELECTION=Path('experiments/multi_horizon_v2_selection.json');INDEX=Path('experiments/multi_horizon_v2_index.json')


def legacy_bundle(data,start):
    cfg=config('configs/byron2017.yaml');cfg['conformal']['rejection_fraction']=.15
    cfg['features']['holidays']=USFederalHolidayCalendar().holidays('2016-01-01','2017-12-31').strftime('%Y-%m-%d').tolist()
    train,cal,_=split_month(data,start);m=ResidualForecaster(copy.deepcopy(cfg)).fit(train,cal);q=fit_quantiles(m,train)
    f=primitives(m,data[data.timestamp<start]);ct=sorted(cal.timestamp.unique());cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
    refs=[np.sort(v) for v in m._components(cq,cq.scale.to_numpy())]
    crisk=sum(w*np.searchsorted(ref,v,side='right')/len(ref) for w,ref,v in zip(cfg['conformal']['risk_weights'],refs,m._components(cq,cq.scale.to_numpy())))
    return dict(backbone=m,quantile_models=q,calibration=cq,risk_threshold=float(np.quantile(crisk,.85,method='higher')))


def groups(frame):
    return {name:summarize(frame[frame.horizon.between(lo,hi)]) for name,lo,hi in [('short',1,3),('long',4,24),('all',1,24)]}


def choose(summary,plan):
    baseline=summary['v1'];eligible=[n for n in plan['candidates'] if summary[n]['short']['mae']<=.9*baseline['short']['mae'] and summary[n]['short']['retained_coverage']>=.875 and summary[n]['long']['mae']<=1.05*baseline['long']['mae']]
    if eligible:return min(eligible,key=lambda n:(summary[n]['short']['mae'],summary[n]['long']['mae'],n)),True
    return min(plan['candidates'],key=lambda n:(summary[n]['all']['mae'],n)),False


def development(data,plan):
    # Never pass2017data to any development feature or fit call.
    dev=data[data.timestamp.dt.year.eq(2016)].copy();f=features(dev);v1=v1_features(dev)
    frames={n:[] for n in ['v1']+plan['candidates']};rows=[]
    for month in range(7,13):
        start=pd.Timestamp(year=2016,month=month,day=1,tz='UTC');end=start+pd.offsets.MonthBegin(1)
        origins=dev.loc[(dev.timestamp>=start)&(dev.timestamp<end),'timestamp']
        one=one_step_at(dev,origins,legacy_bundle(dev,start))
        ev=f[(f.origin>=start)&(f.origin<end)]
        base_ev=v1[(v1.origin>=start)&(v1.origin<end)]
        baseline=v1_predict(v1_fit(v1,start,plan),base_ev);frames['v1'].append(baseline)
        row={'month':str(start.date()),'v1':groups(baseline)}
        for name in plan['candidates']:
            b=fit_month(f,start,plan,name);p=predict(b,ev)
            p=pd.concat([one,p],ignore_index=True).sort_values(['origin','horizon'])
            frames[name].append(p);row[name]=groups(p)
        rows.append(row);print(json.dumps({'development_month':month}),flush=True)
    summary={name:groups(pd.concat(parts,ignore_index=True)) for name,parts in frames.items()};name,passed=choose(summary,plan)
    selection=dict(selected=name,development_gate_passed=passed,summary=summary,monthly_rows=rows,plan_sha256=sha(PLAN))
    SELECTION.write_text(json.dumps(selection,indent=2),encoding='utf-8');return selection


def main():
    if INDEX.exists() or SELECTION.exists():raise FileExistsError('Research immutable: do not repeat final evaluation')
    plan=json.loads(PLAN.read_text(encoding='utf-8'));data=load_data();decision=development(data,plan);name=decision['selected']
    # Decision is now persisted;2017candidate outcomes may be evaluated once.
    f=features(data);past=[];rows=[];cache_root=Path('data/shortfix24');cache_root.mkdir(exist_ok=True)
    old_index=json.loads(Path('experiments/demo_monthly_index.json').read_text())
    for start in pd.date_range('2016-12-01','2017-12-01',freq='MS',tz='UTC'):
        month=start.strftime('%Y-%m');end=start+pd.offsets.MonthBegin(1)
        b=fit_month(f,start,plan,name);ev=f[(f.origin>=start)&(f.origin<end)]
        if start.year==2017:
            item=next(r for r in old_index['rows'] if r['month']==month);assert sha(item['artifact'])==item['artifact_sha256']
            old=joblib.load(item['artifact']);b['one_step_artifact']=item['artifact'];b['one_step_artifact_sha256']=item['artifact_sha256']
        else:old=legacy_bundle(data,start)
        one=one_step_at(data[data.timestamp<end+pd.Timedelta(hours=1)],data.loc[(data.timestamp>=start)&(data.timestamp<end),'timestamp'],old)
        lookups=None;validation_end=None
        if past:
            completed=pd.concat(past,ignore_index=True);completed=completed[(completed.target<start)&completed.y.notna()]
            lookups={int(h):fit_confidence(g) for h,g in completed.groupby('horizon') if h>=2};validation_end=str(completed.target.max())
        p=predict(b,ev,lookups);p=pd.concat([one,p],ignore_index=True).sort_values(['origin','horizon']);past.append(p)
        b['confidence_lookup']=lookups;b['confidence_validation_target_end']=validation_end
        artifact=Path(f'models/{plan["version"]}-{month}.joblib');cache=cache_root/f'{month}.csv'
        if artifact.exists() or cache.exists():raise FileExistsError('Do not overwrite prior evaluation')
        joblib.dump(b,artifact);p.to_csv(cache,index=False)
        if start.year==2017:
            rows.append(dict(month=month,artifact=str(artifact),predictions=str(cache),artifact_sha256=sha(artifact),predictions_sha256=sha(cache),
                train_target_end=max(m['train_target_end'] for lo,hi,m in b['bands']),scale_target_end=max(m['scale_target_end'] for lo,hi,m in b['bands']),
                cq_target_end=max(m['cq_target_end'] for lo,hi,m in b['bands']),confidence_validation_target_end=validation_end,
                h1_confidence_validation_target_end=old['confidence_validation_end'],h1_source_artifact=item['artifact']))
        print(json.dumps({'final_month':month}),flush=True)
    final=pd.concat(past[1:],ignore_index=True);metrics=[dict(horizon=int(h),**summarize(g)) for h,g in final.groupby('horizon')]
    pd.DataFrame(metrics).to_csv('experiments/multi_horizon_v2_metrics.csv',index=False)
    index=dict(status='completed',version=plan['version'],rows=rows,metrics=metrics,plan_sha256=sha(PLAN),selection_sha256=sha(SELECTION),
        selected=name,development_gate_passed=decision['development_gate_passed'],parameters_retuned=False,legacy_model_changed=False,
        total_issued=len(final),total_observed=int(final.y.notna().sum()),final_evaluations=1,
        code_sha256={p:sha(p) for p in ['src/models/shortfix_multi.py','scripts/research_shortfix24.py']})
    INDEX.write_text(json.dumps(index,indent=2),encoding='utf-8');print(json.dumps(metrics),flush=True)


if __name__=='__main__':main()
