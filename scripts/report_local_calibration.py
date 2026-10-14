"""Audit saved predictions; no refitting, threshold selection or online writes."""
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from src.conformal.daily_local import metrics

OUT=Path('experiments/calibration_v1')


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(stage):
    result=json.loads((OUT/(stage+'_results.json')).read_text(encoding='utf-8'))
    assert result['plan_sha256']==sha(OUT/'plan.json')
    chunks=[]
    for receipt in result['predictions']:
        path=receipt['path'];assert sha(path)==receipt['sha256'],path
        p=pd.read_csv(path);p['timestamp']=pd.to_datetime(p.timestamp,utc=True)
        assert len(p)==receipt['rows']
        if stage=='six':p['method']=Path(path).stem.removeprefix('six_')
        if stage!='cold':
            end=pd.to_datetime(p.cal_end,utc=True)
            assert (end<p.timestamp).all()
            if 'daily_' in p.method.iloc[0]:assert (end<p.timestamp.dt.floor('D')).all()
        else:
            assert np.array_equal(p.loc[~p.enabled,'point'],p.loc[~p.enabled,'baseline_point'])
            assert not p.iloc[:168].enabled.any()
            assert not p.iloc[:168].interval_available.any()
        assert not p.duplicated(['building_id','timestamp']).any()
        chunks.append(p)
    return result,pd.concat(chunks,ignore_index=True)


def aggregate(pred, freq, cold=False):
    f=pred.copy();f['date']=f.timestamp.dt.floor('D')
    if freq=='week':f['date']=pd.Timestamp('2017-07-08',tz='UTC')+pd.to_timedelta(((f.timestamp-pd.Timestamp('2017-07-08',tz='UTC')).dt.days//7)*7,unit='D')
    keys=['building_id','date'] if cold else ['method','building_id','date']
    rows=[]
    for values,g in f.groupby(keys):
        if cold:
            e=(g.y-g.point).abs();be=(g.y-g.baseline_point).abs()
            row={'n':len(g),'base_abs_error_sum':float(be.sum()),'candidate_abs_error_sum':float(e.sum()),
                'mae_gain':1-float(e.sum()/be.sum()),'enabled':bool(g.enabled.iloc[0]),
                'interval_available_n':int(g.interval_available.sum()),'covered_available_n':int(g.loc[g.interval_available,'hit'].sum())}
        else:
            keep=g[~g.abstain]
            row={'n':len(g),'retained_n':len(keep),'covered_n':int(g.hit.sum()),'covered_retained_n':int(keep.hit.sum()),
                'rejected_n':int(g.abstain.sum()),'risk_rejected_n':int(g.risk_rejected.sum()),'width_rejected_n':int(g.width_rejected.sum()),
                'abs_error_sum':float((g.y-g.point).abs().sum()),'width_sum':float((g.upper-g.lower).sum())}
        rows.append({**dict(zip(keys,values)),**row})
    return pd.DataFrame(rows)


def intervals_from_week_counts(pred,reps=1000):
    """Post-run descriptive weekly resampling, not a parameter-selection gate."""
    p=pred.copy();p['block']=p.timestamp.dt.strftime('%G-%V')
    groups=[]
    for _,g in p.groupby('block'):
        keep=g[~g.abstain]
        groups.append([len(g),len(keep),int(keep.hit.sum()),int(g.abstain.sum())])
    a=np.array(groups);rng=np.random.default_rng(42)
    totals=a[rng.integers(0,len(a),size=(reps,len(a)))].sum(axis=1)
    coverage=totals[:,2]/totals[:,1];rejection=totals[:,3]/totals[:,0]
    return {'retained_coverage_ci95':np.quantile(coverage,[.025,.975]).tolist(),
        'rejection_rate_ci95':np.quantile(rejection,[.025,.975]).tolist(),'blocks':len(a),'replicates':reps}


def main():
    byron,b=load('byron');six,s=load('six');cold,c=load('cold')
    bd=aggregate(b,'day');sd=aggregate(s,'day');cw=aggregate(c,'week',True)
    bd.to_csv(OUT/'byron_daily_counts.csv',index=False);sd.to_csv(OUT/'six_daily_counts.csv',index=False)
    cw.to_csv(OUT/'cold_weekly_metrics.csv',index=False)
    validations=[]
    for line in (OUT/'cold_log.txt').read_text(encoding='utf-8').splitlines():
        event=json.loads(line)
        for w in event.get('weekly_updates',[]):
            if w['validation']:
                assert w['enabled']==(w['validation']['candidate_mae']<w['validation']['base_mae'])
                assert pd.Timestamp(w['fit_end'])<pd.Timestamp(w['cal_end'])<pd.Timestamp(w['start'])
                assert w['fit_n']>=120 and w['cal_n']>=40
            else:assert not w['enabled'] and w['q'] is None
            validations.append(w)
    assert len(validations)==312
    (OUT/'cold_weekly_decisions.json').write_text(json.dumps(validations,indent=2),encoding='utf-8')
    base=b[b.method.eq('monthly')].sort_values('timestamp')
    for method,p in b.groupby('method'):
        np.testing.assert_array_equal(base.point.to_numpy(),p.sort_values('timestamp').point.to_numpy())
    sixbase=s[s.method.eq('shared_rho15')].sort_values(['building_id','timestamp'])
    for method,p in s.groupby('method'):
        np.testing.assert_array_equal(sixbase.point.to_numpy(),p.sort_values(['building_id','timestamp']).point.to_numpy())
    for method,p in b.groupby('method'):
        for k,v in metrics(p).items():
            assert np.isclose(v,byron['pooled'][method][k]) if v is not None else byron['pooled'][method][k] is None
    comparison=[]
    for r in cold['by_building']:
        p=c[c.building_id.eq(r['building'])]
        bm=float((p.y-p.baseline_point).abs().mean());cm=float((p.y-p.point).abs().mean())
        assert np.isclose(bm,r['base_mae']) and np.isclose(cm,r['candidate_mae'])
        weeks=cw[cw.building_id.eq(r['building'])]
        comparison.append({'building':r['building'],'enabled_weeks_worse':int((weeks.enabled & (weeks.mae_gain<0)).sum()),
            'enabled_weeks':int(weeks.enabled.sum()),'worst_enabled_week_gain':float(weeks.loc[weeks.enabled,'mae_gain'].min())})
    # Same sampled week indices across all 12 buildings preserve shared-site shocks.
    pivot=cw.pivot(index='date',columns='building_id',values=['base_abs_error_sum','candidate_abs_error_sum'])
    aa=pivot['base_abs_error_sum'].to_numpy();bb=pivot['candidate_abs_error_sum'].to_numpy()
    rng=np.random.default_rng(42);ix=rng.integers(0,len(aa),size=(1000,len(aa)))
    gain=(1-bb[ix].sum(axis=1)/aa[ix].sum(axis=1)).mean(axis=1)
    summary={'status':'PASS','claim_scope':'offline chronology/provenance audit, not deployment approval',
        'checks':{'prediction_hashes':True,'daily_past_only':True,'point_frozen_in_daily':True,'cold_activation_rule':True,'cold_fallback_unchanged':True,'weekly_decisions':len(validations)},
        'byron_week_block_ci':{name:intervals_from_week_counts(p) for name,p in b.groupby('method')},
        'cold_shared_week_bootstrap_macro_gain_ci95':np.quantile(gain,[.025,.975]).tolist(),
        'uncertainty_note':'post-run descriptive 1000 week-block resamples, seed42; cannot prove conditional coverage or independent-site transfer',
        'cold_enabled_week_degradation':comparison,
        'cold_pooled_mae_gain':1-float((c.y-c.point).abs().sum()/(c.y-c.baseline_point).abs().sum()),
        'cold_macro_coverage_available':float(np.mean([r['coverage_available'] for r in cold['by_building']])),
        'code_sha256':{path:sha(path) for path in ['scripts/evaluate_local_calibration.py','scripts/report_local_calibration.py','src/conformal/daily_local.py','src/models/residual.py','src/features/build.py','src/data/adapter.py','src/conformal/selective.py']},
        'logs':{str(p):sha(p) for p in OUT.glob('*_log.txt')},'plan_sha256':sha(OUT/'plan.json')}
    (OUT/'audit.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False))


if __name__=='__main__':main()
