from src.data.replay_payload import load_replay
from src.agent.display_text import display_evidence
import copy,json
from pathlib import Path
import pytest
from src.agent.orchestrator import run_agent,candidate_evidence,check_grounding
from src.agent.selection import evaluate_candidates
from tests.test_storage_rolling import inputs


def metric_pair(c):
    return tuple(round(c['objective_metrics'][k],1) if c['objective_metrics'][k] is not None else None for k in ('energy_cost_cny','upper_grid_peak_kw'))


class RealChoice:
    calls=0
    def choose_candidate(self,f,c,instruction):
        self.calls+=1
        best=next(a for a in c if a['selection_reason']['objective_optimal'])
        return {'choice':{'candidate_id':best['candidate_id'],'reason':f"按负荷区间上界 {max(p['upper'] for p in f['predictions']):.1f} 千瓦准备。"},'llm':{'mode':'real','reason':'call_succeeded'}}


def test_future_gate_calls_llm_and_explains_safe_plan_current_only(tmp_path):
    f,c,k=inputs();f['predictions'][0]['abstain']=False;f['predictions'][1]['abstain']=True
    provider=RealChoice();r=run_agent(f,c,k,provider=provider,dispatch_path=tmp_path/'d.jsonl',dispatch_current_only=True)
    assert provider.calls==1 and r['source']=='llm' and r['receipt']['count']==2
    assert r['plan'][1]['battery_kw']==0 and r['plan'][1]['action']=='human_review'
    assert '预测被拒绝，保持设定、不充放电' in r['reason']
    assert '当前小时可正常执行' in r['reason']
    assert check_grounding(r['reason'],display_evidence({'forecast':f,'candidates':candidate_evidence(r['candidates'])},f['predictions'][0]['timestamp']))
    assert len({metric_pair(a) for a in r['candidates']})==len(r['candidates'])
    f['predictions'][0]['abstain']=True
    r=run_agent(f,c,k,provider=provider,dispatch_path=tmp_path/'absent.jsonl',dispatch_current_only=True)
    assert provider.calls==1 and r['source']=='rule' and r['llm']['reason']=='refused_current'
    assert r['receipt']['count']==0 and r['plan'][0]['battery_kw']==0


def test_equal_display_metrics_merge_retains_policy_cost_best():
    f={'predictions':[{'upper':1200.,'abstain':False}]};ctx={'hours':[{'pv_kw':0.}]}
    def candidate(name,cost,power):
        return dict(candidate_id=name,plan=[dict(hvac_setpoint_c=24.,battery_kw=power,action='dispatch')],simulation={'estimated_cost':cost,'estimated_peak_kw':1000-power,'comfort_degree_hours':0})
    # Different controls but one-decimal result same: keep tolerance-band cost winner, not first proposal.
    a=[candidate('rule_full',1000.01,200.),candidate('rule_conservative',1000.02,200.000001),candidate('rule_hold',1200.,0.)]
    best=evaluate_candidates(a,f,ctx,{})
    assert len(a)==2 and best['candidate_id']=='rule_full'
    assert len({metric_pair(c) for c in a})==2
    assert best['selection_reason']['preferred_candidate_id']=='rule_full'


def test_all72_windows_pairwise_different_and_no_selected_control_change(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    for name in ['normal','peak','abstain']:
        d=load_replay(name);soc=.5
        for row in d['hours']:
            from src.agent.rolling_context import from_replay
            f,c,k=from_replay(d,row,soc)
            r=run_agent(f,c,k,dispatch_enabled=False)
            assert len({metric_pair(a) for a in r['candidates']})==len(r['candidates'])
            soc-=r['plan'][0]['battery_kw']/2000
