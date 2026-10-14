import copy,json,itertools
from pathlib import Path
import pytest
from src.agent.selection import evaluate_candidates,policy_order,POLICY,misleading_tradeoff
from src.agent.orchestrator import run_agent
from tests.test_storage_rolling import inputs


def pick(peaks,costs):
    c=[dict(candidate_id=f'c{i}',plan=[dict(hvac_setpoint_c=24.,battery_kw=3000-p,action='dispatch')],simulation={'estimated_cost':cost}) for i,(p,cost) in enumerate(zip(peaks,costs))]
    selected=evaluate_candidates(c,{'predictions':[dict(upper=3000.,abstain=False)]},{'hours':[dict(pv_kw=0.)]}, {})
    return selected,c


@pytest.mark.parametrize('difference,winner',[(0.000000208,1),(.049,1),(.999,1),(1.,1),(1.00001,0)])
def test_absolute_closed_boundary(difference,winner):
    selected,c=pick([800.,800.+difference],[100.,90.])
    assert selected['candidate_id']==f'c{winner}'
    assert not ('多花' in selected['selection_reason']['summary'] and '减少 0.0 kW' in selected['selection_reason']['summary'])


@pytest.mark.parametrize('difference,winner',[(1.999,1),(2.,1),(2.00001,0)])
def test_relative_branch(difference,winner):
    selected,c=pick([2000.,2000.+difference],[100.,90.]);assert selected['candidate_id']==f'c{winner}'


def test_anchor_nontransitive_chain_permutation_independent():
    selected,c=pick([800.,800.8,801.6],[100.,90.,80.])
    assert selected['candidate_id']=='c1'
    for permutation in itertools.permutations(c):assert policy_order(list(permutation))[0][0]['candidate_id']=='c1'


def test_metric_dedup_keeps_tolerance_cost_winner():
    selected,c=pick([1000.,999.999999],[1000.01,1000.02]);assert len(c)==1 and selected['candidate_id']=='c0'


def test_regression_normal14_no_zero_peak_purchase(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');f,c,k=inputs('normal',14)
    result=run_agent(f,c,k,dispatch_enabled=False)
    ordered,minimum,tolerance=policy_order(result['candidates'])
    assert result['selected']==ordered[0]['candidate_id']
    guard=ordered[0]['temperature_optimization']
    assert guard['selection_guard_passed']
    assert all(guard['after'][key]<=value+1e-7 for key,value in guard['selection_guard_caps'].items())
    selection=result['selection_reason']
    if selection['additional_cost_cny']>0:
        assert selection['raw_upper_peak_reduction_vs_cheapest_kw']>selection['peak_tolerance_kw']
    assert not misleading_tradeoff(result['reason'],selection)
    assert '容差' not in result['reason'] and result['selection_reason']['policy']==POLICY
    for a in result['candidates']:assert '多花' not in a['selection_reason']['summary'] or '减少 0.0 kW' not in a['selection_reason']['summary']


def test_raw_boundary_gain_does_not_round_to_tolerance_purchase():
    selected,c=pick([800.,801.00001],[100.,90.])
    assert selected['candidate_id']=='c0' and '多花' not in selected['selection_reason']['summary']


def test_dedup_preserves_original_band_anchor():
    selected,c=pick([2000.,2000.04,2002.00002],[1000.02,1000.01,1000.])
    assert selected['candidate_id']=='c1'
    assert selected['selection_reason']['minimum_candidate_upper_peak_kw']==2000.
    assert selected['selection_reason']['peak_tolerance_kw']==2.
    assert '多花' not in selected['selection_reason']['summary']


def test_explicit_small_peak_claim_invalid_even_if_true_gain_is_large():
    selected,c=pick([800.,850.],[100.,90.]);s=selected['selection_reason']
    assert misleading_tradeoff('多花10.0元减少0.5千瓦。',s)
    assert not misleading_tradeoff('多花10.0元减少50.0千瓦。',s)


def test_llm_zero_peak_tradeoff_prose_templated_choice_kept():
    f,c,k=inputs('normal',14)
    class Bad:
        def choose_candidate(self,f,c,i):
            best=next(a for a in c if a['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':'为了压低峰值，多花0.0元减少0.0千瓦。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=run_agent(f,c,k,provider=Bad(),dispatch_enabled=False)
    assert r['source']=='llm' and r['explanation_source']=='template'
    assert '多花' not in r['reason']
