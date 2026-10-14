import json,subprocess
from pathlib import Path
from src.agent.orchestrator import run_agent
from scripts.annotate_storage_reserve import TEXT
from tests.test_storage_rolling import inputs


def test_export_abstain_annotation_text_only_and_forecast_supported():
    data=json.loads(subprocess.check_output(['git','show','bda65cb:exports/replay/abstain.json']).decode('utf-8'))
    old=json.loads(subprocess.check_output(['git','show','656c56f:exports/replay/abstain.json']).decode())
    # New policy may change storage/grid/selected, but no forecast/data changes.
    for row,previous in zip(data['hours'],old['hours']):
        assert {k:v for k,v in row.items() if k not in ('agent','storage','grid_kw')}=={k:v for k,v in previous.items() if k not in ('agent','storage','grid_kw')}
        assert row['agent']['hvac_setpoint_c']==previous['agent']['hvac_setpoint_c']
    for row in data['hours']:
        future_refused=any(p['abstain'] for p in row['forecast_24h'][:23])
        assert (TEXT in row['agent']['explanation'])==future_refused
        assert (TEXT in row['agent']['selection_reason']['summary'])==future_refused
    assert .5<=data['hours'][-1]['storage']['soc']<=.95


def test_live_reason_uses_future_gate_without_control_change(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');f,c,k=inputs('abstain',hour=12)
    r=run_agent(f,c,k,dispatch_enabled=False)
    assert '预测被拒绝，保持设定、不充放电，需值班人员复核' in r['reason']
    assert r['reason'].count('后续时段预测被拒绝')==0
    for p,fp in zip(r['plan'],f['predictions']):
        if fp['abstain']:assert p['battery_kw']==0
