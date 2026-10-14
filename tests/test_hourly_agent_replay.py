from src.data.replay_payload import load_replay
import json
from pathlib import Path
import math
import pytest
from src.agent.orchestrator import run_agent


def test_current_only_dispatch_does_not_send_lookahead(tmp_path,monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    times=['2017-07-20T12:00:00-05:00','2017-07-20T13:00:00-05:00']
    f={'building_id':'A','predictions':[dict(timestamp=t,point=1000.,lower=900.,upper=1200.,abstain=False,confidence=.9) for t in times]}
    c={'hours':[dict(timestamp=t,tariff_period='peak',pv_kw=0.,outdoor_temp_c=30.,price_per_kwh=1.) for t in times]}
    path=tmp_path/'d.jsonl';r=run_agent(f,c,dispatch_path=path,dispatch_current_only=True)
    assert len(r['plan'])==2 and r['receipt']['count']==2
    assert times[1] not in path.read_text()


def test_exported_hourly_agent_contract_and_device_conservation():
    receipt=Path('experiments/agent_replay_export.json')
    assert receipt.exists(),'Frozen export evidence missing'
    total={'llm':0,'rule':0,'mock':0}
    latest=json.loads(Path('experiments/round78_export.json').read_text())
    assert latest['new_llm_calls']==latest['new_dispatches']==0
    expected={'llm':0,'rule':0,'mock':0}
    for scenario in ('normal','peak','abstain'):
        d=load_replay(scenario)
        soc=.5
        for row in d['hours']:
            agent=row['agent'];total[agent['source']]+=1
            assert not any(word in agent['explanation']+' '.join(agent['actions']) for word in ('影子','模拟','估算'))
            soc-=row['storage']['power_kw']/2000
            assert math.isclose(soc,row['storage']['soc'],abs_tol=1e-6)
            assert .1-1e-8<=soc<=.95+1e-8
            assert math.isclose(row['grid_kw'],max(0.,row['actual_kw']-row['storage']['power_kw']-row['pv']['power_kw']),abs_tol=.051)
            if row['abstain']:
                assert agent['status']=='handoff' and agent['work_orders'] and agent['receipt']['count']==0
                assert row['storage']['power_kw']==0
            else:
                assert agent['status']=='executed' and agent['receipt']['count']==0
                assert agent['receipt']['elapsed_ms']==0.0 and not agent['receipt']['device_connected']
                assert agent['llm']['offline_control_refresh'] and 'historical_receipt' in agent['llm']
                assert f"EMS储能功率 {row['storage']['power_kw']:.1f} kW" in agent['actions']
    r=json.loads(receipt.read_text(encoding='utf-8'))
    for scenario in latest['scenarios'].values():
        categories=scenario['source_counts_after']
        expected['llm']+=categories.get('llm',0)+categories.get('template',0)
        expected['rule']+=categories.get('rule',0)
    assert total==expected and sum(total.values())==72
    assert r['llm_status']['mode']=='real'
    assert r['current_hour_dispatch_only'] is True


def test_export_schema_accepts_work_orders_and_receipts():
    from jsonschema import Draft202012Validator
    schema=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    assert 'work_orders' in schema['$defs']['hour']['properties']['agent']['properties']
    assert schema['$defs']['hour']['properties']['agent']['properties']['source']['enum']==['llm','rule','mock']
    Draft202012Validator.check_schema(schema)
