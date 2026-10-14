from src.data.replay_payload import load_replay
import json
from collections import Counter
from pathlib import Path
import pytest
from src.agent.orchestrator import check_grounding,rounded_tools
from src.agent.display_text import display_evidence
from src.agent.tools import tool_config,check_constraints


def test_real_refresh_receipt_and_each_full_precision_objective():
    receipt=json.loads(Path('experiments/agent_replay_export.json').read_text())
    assert receipt['controls_refreshed'] and receipt['selection_policy']=='upper_grid_peak_tolerance_then_cost_v2' and receipt['real_mode_requested']
    latest=json.loads(Path('experiments/round78_export.json').read_text())
    assert latest['new_llm_calls']==latest['new_dispatches']==0
    totals=Counter();expected_totals=Counter()
    for name in ['normal','peak','abstain']:
        d=load_replay(name);counts=Counter();reasons=Counter();soc=.5
        for row in d['hours']:
            a=row['agent'];counts[a['source']]+=1;totals[a['source']]+=1
            limits={**tool_config()['equipment'],'initial_soc':soc}
            choice=next(c for c in a['candidates'] if c['candidate_id']==a['selected'])
            # Exported candidates are rounded evidence; full precision control still in current row.
            assert choice['plan'][0]['timestamp']==row['t'] and a['selection_reason']['objective_optimal']
            assert a['selected']==a['selection_reason']['selected_candidate_id']==a['selection_reason']['preferred_candidate_id']
            assert check_grounding(a['selection_reason']['summary'],display_evidence({'candidates':rounded_tools(a['candidates']),'prepared_upper_kw':max(p['upper_kw'] for p in row['forecast_24h']),'charge_kw':round(max(0.,-row['storage']['power_kw']),1)},row['t']))
            assert check_grounding(a['explanation'],display_evidence({'candidates':rounded_tools(a['candidates']),'prepared_upper_kw':max(p['upper_kw'] for p in row['forecast_24h']),'charge_kw':round(max(0.,-row['storage']['power_kw']),1)},row['t']))
            if a['source']=='llm':assert a['llm']['mode']=='real' and a['llm']['reason']=='call_succeeded'
            else:reasons[a['llm']['reason']]+=1
            control=dict(timestamp=row['t'],hvac_setpoint_c=a['hvac_setpoint_c'],battery_kw=row['storage']['power_kw'],action='human_review' if row['abstain'] else 'hold')
            assert check_constraints([control],limits)==[]
            soc-=row['storage']['power_kw']/2000;assert soc==pytest.approx(row['storage']['soc'],abs=1e-6)
        categorized=latest['scenarios'][name]['source_counts_after']
        expected={'llm':categorized.get('llm',0)+categorized.get('template',0),'rule':categorized.get('rule',0)}
        expected={k:v for k,v in expected.items() if v}
        assert dict(counts)==expected
        assert sum(reasons.values())==expected.get('rule',0)
        assert [h['t'][11:13] for h in d['hours'] if h['abstain']]==[f'{h:02d}' for h in latest['scenarios'][name]['refusal_hours_after']]
        expected_totals.update(expected)
    assert totals==expected_totals and sum(totals.values())==72
