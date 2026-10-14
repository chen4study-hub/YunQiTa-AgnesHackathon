from tests.test_frozen_economics import historical_economics
"""Frozen evaluation/export regression, offline only; do not rerun real provider."""
import json,re,subprocess
from pathlib import Path
import pytest
from src.agent.tools import check_constraints
from scripts.report_agent13 import summarize
from scripts.report_agent24 import storage_metrics
from scripts.evaluate_agent13 import current_economics
from src.agent.orchestrator import candidate_evidence,rounded_tools,ungrounded_numbers,reason_format_invalid


def test_312_first_step_costs_soc_safety_and_two_baselines():
    rows=[json.loads(l) for l in Path('experiments/agent_eval_v2_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    summary=json.loads(Path('experiments/agent_eval_v2_summary.json').read_text())
    assert len(rows)==len({(r['date'],r['hour']) for r in rows})==312
    for k,v in {**summarize(rows),**storage_metrics(rows)}.items():assert summary['summary'][k]==v
    for date in {r['date'] for r in rows}:
        day=sorted([r for r in rows if r['date']==date],key=lambda r:r['hour']);soc=.5
        for r in day:
            f=r['forecast'];ctx=r['context'];limits=r['constraints'];result=r['result'];p=result['plan'][0]
            assert len(f['predictions'])==len(result['plan'])==24 and r['soc_before']==pytest.approx(soc)
            assert not check_constraints(result['plan'],limits)
            soc-=p['battery_kw']/limits['battery_capacity_kwh'];assert r['soc_after']==pytest.approx(soc)
            assert .1<=soc<=.95 and sum(x['battery_kw'] for x in result['plan'])<=1e-5
            assert historical_economics(p,f,ctx,limits)==r['economics']
            assert all(h['outdoor_temp_c']==ctx['hours'][0]['outdoor_temp_c'] for h in ctx['hours'])
            assert all(h['pv_kw']==0 for h in ctx['hours'][1:])
            assert not re.search('[A-Za-z]',result['reason']+result['selection_reason']['summary'])
            assert not ungrounded_numbers(result['reason'],{'forecast':rounded_tools(f),'candidates':candidate_evidence(result['candidates'])})
            if r['current_refused']:
                assert p['action']=='human_review' and p['battery_kw']==0 and result['receipt']['count']==0
                assert r['current_handoff_correct']
            else:assert result['receipt']['count']==2
            keys=[]
            for a in result['candidates']:
                assert not check_constraints(a['plan'],limits)
                assert sum(x['battery_kw'] for x in a['plan'])<=1e-5
                keys.append(tuple((round(x['battery_kw'],6),x['hvac_setpoint_c'],x['action']) for x in a['plan']))
                cost=0.;accepted=0
                for cmd,fp,h in zip(a['plan'],f['predictions'],ctx['hours']):
                    if fp['abstain']:assert cmd['battery_kw']==0;continue
                    accepted+=1
                    if cmd['battery_kw']<0:assert h['tariff_period']=='valley'
                    if cmd['battery_kw']>0:assert h['tariff_period']=='peak'
                    cost+=max(0,fp['point']*.955-h['pv_kw']-cmd['battery_kw'])*h['price_per_kwh']
                if accepted:assert a['simulation']['estimated_cost']==pytest.approx(cost)
                else:assert a['simulation']['estimated_cost'] is None
            assert len(set(keys))==len(keys)
    assert summary['summary']['cost_reduction_vs_hold25_cny']>0


def test_three_exports_preserve_forecast_gates_and_unrelated_fields_from_previous_commit():
    for name in ['normal','peak','abstain']:
        data=json.loads(subprocess.check_output(['git','show',f'bda65cb:exports/replay/{name}.json']).decode('utf-8'))
        old=json.loads(subprocess.check_output(['git','show',f'f6234ff:exports/replay/{name}.json']).decode('utf-8'))
        assert data['schema_version']=='1.4' and data['meta']==old['meta'] and {k:v for k,v in data['energy_summary'].items() if k!='label'}=={k:v for k,v in old['energy_summary'].items() if k!='label'}
        for row,prev in zip(data['hours'],old['hours']):
            assert {k:v for k,v in row.items() if k not in ('storage','grid_kw','agent')}=={k:v for k,v in prev.items() if k not in ('storage','grid_kw','agent')}
            for c in row['agent']['candidates']:
                assert len(c['plan'])==24
                assert not reason_format_invalid(c['selection_reason']['summary'])
                assert all(not reason_format_invalid(p['reason']) for p in c['plan'])
            assert not reason_format_invalid(row['agent']['explanation'])
        assert any(r['storage']['power_kw']<0 for r in data['hours']) or name=='peak'
        assert any(r['storage']['power_kw']>0 for r in data['hours']) or name=='abstain'
