from tests.test_frozen_economics import historical_economics
"""Offline evaluation accounting/gate/security checks; never call provider."""
from collections import Counter
import copy
import json
from pathlib import Path
from datetime import datetime
import pytest
from scripts.evaluate_agent13 import current_economics,dates
from scripts.report_agent13 import summarize
from src.agent.tools import tool_config,check_constraints
from src.agent.orchestrator import ungrounded_numbers,rounded_tools,candidate_evidence
from src.agent.provider import redact


def fixture_row(refused=False,source='llm'):
    cfg=tool_config();t='2017-01-04T10:00:00-06:00';r=dict(timestamp=t,point=1000.,upper=1200.,lower=800.,abstain=refused)
    h=dict(timestamp=t,pv_kw=100.,price_per_kwh=1.2,outdoor_temp_c=20.)
    p=dict(timestamp=t,hvac_setpoint_c=25.5,battery_kw=0. if refused else 100.,action='human_review' if refused else 'dispatch')
    return dict(date='2017-01-04',hour=10,economics=current_economics(p,{'predictions':[r]},{'hours':[h]},cfg['equipment']),
        soc_before=.5,soc_after=.5 if refused else .45,current_refused=refused,current_handoff_correct=True if refused else None,
        refused_steps=[{'correct':True}] if refused else [],constraint_codes=[],current_constraint_codes=[],candidate_constraint_codes={},
        explanation_unsourced_numeric_token_count=0,provider_attempts=[] if refused else [dict(mode='real',reason='call_succeeded',unsourced_numeric_token_count=0)],
        result={'source':source,'llm':{'mode':'rule' if refused else 'real','reason':'refused_horizon' if refused else 'call_succeeded'},'receipt':{'count':0 if refused else 2}})


def test_current_economic_accounting_and_two_baselines():
    row=fixture_row();e=row['economics']
    assert e['baseline_cost']==1080 and e['cost']==pytest.approx(906)
    assert e['upper_peak']==946 and e['baseline_upper_peak']==1100
    assert e['hold25_cost']==pytest.approx(1026)
    s=summarize([row,fixture_row(True,'rule')])
    assert s['cost_reduction_cny']==pytest.approx(174) and s['cost_reduction_vs_hold25_cny']==pytest.approx(120)
    assert s['current_refused_handoff_fraction']==1 and s['current_refused_hours']==1
    assert s['validated_real_llm_hours']==1 and s['degraded_hours']==0 and s['provider_bypass_hours']==1
    assert s['provider_calls']==1 and s['dispatched_current_commands']==2
    assert summarize([])['current_refused_handoff_fraction'] is None
    assert summarize([fixture_row(True,'rule')])['cost_reduction_cny'] is None


def test_no_pretty_clipping_and_degradation_semantics():
    row=fixture_row();row['economics']['cost']=1200;row['economics']['upper_peak']=1300
    row['result']['source']='rule';row['result']['llm']={'mode':'rule','reason':'grounding_failed'}
    row['provider_attempts']*=2;s=summarize([row])
    assert s['cost_reduction_cny']==-120 and s['upper_peak_reduction_kw']==-200
    assert s['degraded_hours']==1 and s['provider_transport_succeeded_calls']==2 and s['validated_real_llm_hours']==0
    assert s['degradation_reasons']=={'grounding_failed':1}


def test_frozen_calendar_selection_and_credential_redaction():
    p=json.loads(Path('experiments/agent_eval_v1_plan.json').read_text());all_dates=dates(p)
    assert len(all_dates)==13 and len({x['date'] for x in all_dates})==13
    extra=[x['date'] for x in all_dates if x['group']=='additional']
    assert '2017-11-23' in extra
    for month in [1,4,7,10]:
        ds=[datetime.fromisoformat(d) for d in extra if int(d[5:7])==month]
        assert sorted(d.weekday() for d in ds)==[2,5] and all(d.day<=7 for d in ds)
    assert redact({'x':'pretend-eval-secret'},'pretend-eval-secret')['x']!='pretend-eval-secret'


def test_saved_complete_evaluation_recomputed_offline():
    p=Path('experiments/agent_eval_v1_summary.json')
    assert p.exists(),'Frozen evaluation evidence missing'
    summary=json.loads(p.read_text());rows=[json.loads(l) for l in Path('experiments/agent_eval_v1_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(rows)==312 and len({(r['date'],r['hour']) for r in rows})==312
    recomputed=summarize(rows)
    for k,v in recomputed.items():assert summary['summary'][k]==v
    for day in summary['days']:
        current=sorted([r for r in rows if r['date']==day['date']],key=lambda r:r['hour']);soc=.5
        for r in current:
            assert r['soc_before']==pytest.approx(soc);command=r['result']['plan'][0];soc-=command['battery_kw']/2000
            assert r['soc_after']==pytest.approx(soc)
            horizon_soc=r['soc_before']
            for command_step in r['result']['plan']:
                assert 24<=command_step['hvac_setpoint_c']<=27 and abs(command_step['battery_kw'])<=500
                horizon_soc-=command_step['battery_kw']/2000
                assert .1-1e-9<=horizon_soc<=.95+1e-9
            assert .1-1e-9<=soc<=.95+1e-9
            assert check_constraints(r['result']['plan'],r['constraints'])==r['constraint_codes']
            econ=historical_economics(command,r['forecast'],r['context'],r['constraints'])
            assert econ==r['economics']
            if not r['current_refused']:
                pred=r['forecast']['predictions'][0];ctx=r['context']['hours'][0]
                factor=max(0,1-.03*(command['hvac_setpoint_c']-24)+.05*(command['action']=='precool'))
                assert econ['cost']==pytest.approx(max(0,pred['point']*factor-ctx['pv_kw']-command['battery_kw'])*ctx['price_per_kwh'])
                assert econ['upper_peak']==pytest.approx(max(0,pred['upper']*factor-ctx['pv_kw']-command['battery_kw']))
            grounded=ungrounded_numbers(r['result']['reason'],{'forecast':rounded_tools(r['forecast']),'candidates':candidate_evidence(r['result']['candidates'])})
            assert len(grounded)==r['explanation_unsourced_numeric_token_count']
            if r['current_refused']:
                assert r['current_handoff_correct'] and command['action']=='human_review' and r['result']['receipt']['count']==0
            assert r['result']['selected']==r['result']['selection_reason']['preferred_candidate_id']
        assert day['final_soc']==pytest.approx(soc)
    def forbidden(value):
        if isinstance(value,dict):
            assert not set(value).intersection({'api_key','authorization','request_body','response_body'})
            for v in value.values():forbidden(v)
        elif isinstance(value,list):
            for v in value:forbidden(v)
    forbidden(rows)
