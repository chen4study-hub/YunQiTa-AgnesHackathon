from src.data.replay_payload import load_replay
import json
from pathlib import Path
import pytest
from src.agent.selection import evaluate_candidates,selection_reason
from src.agent.orchestrator import rounded_tools,run_agent,check_grounding
from tests.test_agent_orchestrator import fixtures
from src.agent.display_text import display_evidence


def candidates(costs,powers):
    return [dict(candidate_id=name,plan=[dict(hvac_setpoint_c=24.,battery_kw=power,action='dispatch')],simulation={'estimated_cost':cost,'estimated_peak_kw':1000.-power,'comfort_degree_hours':0.}) for name,cost,power in zip(['rule_full','rule_conservative','rule_hold'],costs,powers)]


def test_higher_cost_only_chosen_when_upper_peak_genuinely_lower():
    f={'predictions':[dict(upper=1200.,abstain=False)]};ctx={'hours':[dict(pv_kw=0.)]}
    c=candidates([1352.,1306.7,1400.],[200.,100.,0.]);p=evaluate_candidates(c,f,ctx,{})
    assert p['candidate_id']=='rule_full'
    reason=p['selection_reason'];assert reason['additional_cost_cny']==45.3 and reason['upper_peak_reduction_vs_cheapest_kw']==100.
    assert '为压低区间上界峰值多花 45.3 元' in reason['summary'] and check_grounding(reason['summary'],reason)
    assert reason['policy']['peak_penalty_cny_per_kw'] is None
    c=candidates([1352.,1306.7,1400.],[100.,100.,0.]);p=evaluate_candidates(c,f,ctx,{})
    assert p['candidate_id']=='rule_conservative' and p['selection_reason']['additional_cost_cny']==0.


def test_llm_dominated_choice_retries_and_uses_objective_rule(tmp_path):
    f,c=fixtures()
    class Bad:
        calls=0
        def choose_candidate(self,*a):
            self.calls+=1;return {'choice':{'candidate_id':'rule_full','reason':'按区间上界1200.0 kW准备。'},'llm':{'mode':'real'}}
    p=Bad();r=run_agent(f,c,provider=p,dispatch_enabled=False)
    assert p.calls==2 and r['selected']=='rule_hold' and r['source']=='rule'
    assert r['llm']['reason']=='objective_choice_failed' and r['selection_reason']['objective_optimal']
    assert check_grounding(r['reason'],{'forecast':f,'candidates':r['candidates']})


def test_incomplete_cost_has_no_invented_yuan_difference():
    f,c=fixtures()
    for h in c['hours']:h['outdoor_temp_c']=None
    class Demo:
        def choose_candidate(self,forecast,candidates,instruction):
            preferred=next(x for x in candidates if x['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':preferred['candidate_id'],'reason':'按上界1200.0 kW准备。'},'llm':{'mode':'demo'}}
    r=run_agent(f,c,provider=Demo(),dispatch_enabled=False)
    assert r['selection_reason']['additional_cost_cny'] is None
    assert all(c['objective_metrics']['energy_cost_cny'] is None for c in r['candidates'])


def test_refreshed_selection_matches_real_run_agent_objective():
    for name in ['normal','peak','abstain']:
        d=load_replay(name)
        for row in d['hours']:
            agent=row['agent'];r=agent['selection_reason']
            assert 'audit' not in r and r['policy']['id']=='upper_grid_peak_tolerance_then_cost_v2'
            assert agent['selected']==r['selected_candidate_id']==r['preferred_candidate_id'] and r['objective_optimal']
            assert check_grounding(r['summary'],display_evidence({'candidates':rounded_tools(agent['candidates']),'prepared_upper_kw':max(p['upper_kw'] for p in row['forecast_24h']),'charge_kw':round(max(0.,-row['storage']['power_kw']),1)},row['t']))
            selected=next(c for c in agent['candidates'] if c['candidate_id']==agent['selected'])
            assert selected['plan'][0]['hvac_setpoint_c']==agent['hvac_setpoint_c']
            assert selected['plan'][0]['battery_kw']==row['storage']['power_kw']
            assert r['metrics'][agent['selected']]==selected['selection_reason']['metrics'][agent['selected']]
            assert check_grounding(agent['explanation'],display_evidence({'candidates':rounded_tools(agent['candidates']),'prepared_upper_kw':max(p['upper_kw'] for p in row['forecast_24h']),'charge_kw':round(max(0.,-row['storage']['power_kw']),1)},row['t']))
            if agent['source']=='llm':assert agent['llm_mode']=='real' and agent['llm']['reason']=='call_succeeded'
    d=load_replay('normal');agent=d['hours'][14]['agent']
    assert agent['selected'] in ('rule_full','rule_conservative') and agent['hvac_setpoint_c']==25.5
    selected=next(c for c in agent['candidates'] if c['candidate_id']==agent['selected'])
    assert d['hours'][14]['storage']['power_kw']==selected['plan'][0]['battery_kw']>0
    assert len({str([(p['battery_kw'],p['hvac_setpoint_c']) for p in c['plan']]) for c in agent['candidates']})==len(agent['candidates'])
    assert all(len(c['plan'])==24 for c in agent['candidates'])
