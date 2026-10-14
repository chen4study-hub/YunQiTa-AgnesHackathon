"""Freeze2016bridge weights, once2017evaluation, no replay-derived parameter selection."""
import json
from pathlib import Path
import joblib
import pandas as pd
from scripts.research_holiday_calibration import load_data
from scripts.research_shortfix24 import legacy_bundle
from scripts.backtest_direct24 import summarize,sha
from scripts.prepare_demo_monthly import fit_confidence
from src.models.shortfix_multi import features,fit_month as fit_v2,predict as predict_v2,one_step_at
from src.models.blend_multi import fit_month,predict,seam_metrics

PLAN=Path('experiments/multi_horizon_v3_plan.json');SELECT=Path('experiments/multi_horizon_v3_selection.json');INDEX=Path('experiments/multi_horizon_v3_index.json')


def summary(f):
    return dict(bridge=summarize(f[f.horizon.between(3,6)]),seam34=seam_metrics(f),seam67=seam_metrics(f,6,7))


def choose(s):
    base=s['v2'];eligible=[n for n in s if n!='v2' and s[n]['bridge']['mae']<=base['bridge']['mae']*1.05 and s[n]['bridge']['retained_coverage']>=.875 and s[n]['seam34']['mean_abs_delta_error']<=base['seam34']['mean_abs_delta_error']*.9]
    names=eligible or [n for n in s if n!='v2']
    return min(names,key=lambda n:(s[n]['seam34']['mean_abs_delta_error'],s[n]['bridge']['mae'],n)),bool(eligible)


def main():
    if SELECT.exists() or INDEX.exists():raise FileExistsError('Immutable evaluation: do not retune/repeat final')
    plan=json.loads(PLAN.read_text());data=load_data();dev=data[data.timestamp.dt.year.eq(2016)];f=features(dev)
    frames={n:[] for n in ['v2']+list(plan['candidates'])}
    for month in range(7,13):
        start=pd.Timestamp(year=2016,month=month,day=1,tz='UTC');end=start+pd.offsets.MonthBegin(1)
        ev=f[(f.origin>=start)&(f.origin<end)];base=fit_v2(f,start,plan,'latest_segmented');frames['v2'].append(predict_v2(base,ev))
        experts=None
        for name,weights in plan['candidates'].items():
            bundle=fit_month(f,start,plan,weights,base=base,experts=experts);experts=(bundle['short'],bundle['long'])
            frames[name].append(predict(bundle,ev))
        print(json.dumps({'development_month':month}),flush=True)
    stats={n:summary(pd.concat(v,ignore_index=True)) for n,v in frames.items()};name,passed=choose(stats)
    decision=dict(selected=name,development_gate_passed=passed,summary=stats,plan_sha256=sha(PLAN))
    SELECT.write_text(json.dumps(decision,indent=2),encoding='utf-8')
    # All decisions frozen before any new2017candidate outcome evaluated.
    f=features(data);past=[];rows=[];cache_root=Path('data/blend24');cache_root.mkdir(exist_ok=True)
    old=json.loads(Path('experiments/multi_horizon_v2_index.json').read_text());one_index=json.loads(Path('experiments/demo_monthly_index.json').read_text())
    for start in pd.date_range('2016-12-01','2017-12-01',freq='MS',tz='UTC'):
        month=start.strftime('%Y-%m');end=start+pd.offsets.MonthBegin(1)
        if start.year==2017:
            item=next(r for r in old['rows'] if r['month']==month);assert sha(item['artifact'])==item['artifact_sha256']
            base=joblib.load(item['artifact'])
            one_item=next(r for r in one_index['rows'] if r['month']==month);assert sha(one_item['artifact'])==one_item['artifact_sha256']
            one_bundle=joblib.load(one_item['artifact'])
        else:base=fit_v2(f,start,plan,'latest_segmented');one_bundle=legacy_bundle(data,start)
        bundle=fit_month(f,start,plan,plan['candidates'][name],base=base)
        ev=f[(f.origin>=start)&(f.origin<end)];lookups=None;validation_end=None
        if past:
            completed=pd.concat(past,ignore_index=True);completed=completed[(completed.target<start)&completed.y.notna()]
            lookups={int(h):fit_confidence(g) for h,g in completed.groupby('horizon') if h>=2};validation_end=str(completed.target.max())
        p=predict(bundle,ev,lookups)
        one=one_step_at(data[data.timestamp<end+pd.Timedelta(hours=1)],data.loc[(data.timestamp>=start)&(data.timestamp<end),'timestamp'],one_bundle)
        p=pd.concat([one,p],ignore_index=True).sort_values(['origin','horizon']);past.append(p)
        bundle['confidence_lookup']=lookups;bundle['confidence_validation_target_end']=validation_end
        artifact=Path(f'models/{plan["version"]}-{month}.joblib');cache=cache_root/f'{month}.csv'
        if artifact.exists() or cache.exists():raise FileExistsError('Refuse overwrite')
        joblib.dump(bundle,artifact);p.to_csv(cache,index=False)
        if start.year==2017:rows.append(dict(month=month,artifact=str(artifact),predictions=str(cache),artifact_sha256=sha(artifact),predictions_sha256=sha(cache),
            confidence_validation_target_end=validation_end,cq_target_end=bundle['short']['cq_target_end'],train_target_end=bundle['short']['train_target_end'],
            scale_target_end=bundle['short']['scale_target_end'],base_artifact=item['artifact'],base_sha256=item['artifact_sha256']))
        print(json.dumps({'final_month':month}),flush=True)
    final=pd.concat(past[1:],ignore_index=True);metrics=[dict(horizon=int(h),**summarize(g)) for h,g in final.groupby('horizon')]
    baseline=pd.concat([pd.read_csv(r['predictions']) for r in old['rows']],ignore_index=True)
    pd.DataFrame(metrics).to_csv('experiments/multi_horizon_v3_metrics.csv',index=False)
    result=dict(version=plan['version'],status='completed',selected=name,weights=plan['candidates'][name],development_gate_passed=passed,rows=rows,metrics=metrics,
        plan_sha256=sha(PLAN),selection_sha256=sha(SELECT),final_evaluations=1,parameters_retuned=False,legacy_model_changed=False,
        seam_before=summary(baseline),seam_after=summary(final),code_sha256={p:sha(p) for p in ['src/models/blend_multi.py','scripts/research_blend24.py']})
    INDEX.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps({'selected':name,'seam_before':result['seam_before'],'seam_after':result['seam_after']}),flush=True)


if __name__=='__main__':main()
