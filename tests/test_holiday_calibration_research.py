import hashlib
import json
from pathlib import Path
import pandas as pd
import pytest
from scripts.research_holiday_calibration import choose,grouped_predict


def test_research_frozen_plan_and_pooled_metrics():
    plan=Path('experiments/holiday_calibration_v1_plan.json')
    d=json.loads(Path('experiments/holiday_calibration_v1_results.json').read_text())
    assert d['selection']['plan_sha256']==hashlib.sha256(plan.read_bytes()).hexdigest()
    assert d['final_evaluations']==1 and not d['promoted'] and not d['replay_changed']
    selected,passed=choose(d['selection']['development'],json.loads(plan.read_text()))
    assert (selected,passed)==(d['selection']['selected'],d['selection']['development_gate_passed'])
    for group in ['holiday','ordinary']:
        rows=[r['metrics'][group] for r in d['final_rows'] if r['metrics'][group]['n']]
        n=sum(r['n'] for r in rows);kept=sum(r['retained_n'] for r in rows)
        expected=d['final_selected'][group]
        assert n==expected['n'] and kept==expected['retained_n']
        assert 1-kept/n==pytest.approx(expected['rejection'])
        assert sum(r['retained_n']*(r['coverage'] or 0) for r in rows)/kept==pytest.approx(expected['coverage'])
    for r in d['final_rows']:
        assert pd.Timestamp(r['train_end'])<pd.Timestamp(r['cq_start'])<pd.Timestamp(r['cq_end'])<pd.Timestamp(r['month'],tz='UTC')


def test_group_calibration_small_group_fallback_is_prior_only(monkeypatch):
    from scripts import research_holiday_calibration as script
    cq=pd.DataFrame({'holiday':[False,False,True],'timestamp':pd.date_range('2016-01-01',periods=3,tz='UTC')})
    ev=pd.DataFrame({'holiday':[False,True],'timestamp':pd.date_range('2016-02-01',periods=2,tz='UTC')})
    seen=[]
    def fake(model,cal,evaluation,*args,**kw):
        assert cal.timestamp.max()<evaluation.timestamp.min()
        seen.append(len(cal));return evaluation.copy()
    monkeypatch.setattr(script,'run',fake)
    result,count=grouped_predict(None,cq,ev,None,{'minimum_group_cq_hours':2,'rho':.15})
    assert seen==[2,3] and count==1 and len(result)==2
