from src.data.replay_payload import load_replay
import copy
import json
from pathlib import Path
from datetime import datetime,timedelta
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent.orchestrator import check_grounding
from src.agent.chat import answer

client=TestClient(api.app)


@pytest.fixture(params=['demo','missing_config'])
def offline(request,monkeypatch,tmp_path):
    # No .env/process LLM settings means provider falls back offline; do not remove user .env.
    for key in ['LLM_MODE','LLM_API_KEY','LLM_API_KEY_FILE','LLM_BASE_URL','LLM_MODEL']:
        monkeypatch.delenv(key,raising=False)
    if request.param=='demo':monkeypatch.setenv('LLM_MODE','demo')
    from src.agent import provider
    monkeypatch.setattr(provider.httpx,'Client',lambda **kw:pytest.fail('offline endpoints must not network'))
    data=load_replay('normal')
    monkeypatch.setattr(api,'replay_scenario',lambda name:copy.deepcopy(data))
    monkeypatch.setattr(api,'ROOT',tmp_path)
    return data,tmp_path


def test_schedule_uses_agent_explain_never_dispatches_and_chat_offline(offline):
    data,tmp=offline;row=data['hours'][12]
    req={'building_id':data['meta']['building_id'],'scenario':'normal','start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    r=client.post('/explain',json=req);assert r.status_code==200
    e=r.json();assert e['llm_mode']=='demo' and e['receipt']['count']==0 and not e['dispatch_enabled']
    assert not e['needs_human']  # future refusal must not become current handoff
    assert not (tmp/'logs/dispatch.jsonl').exists()
    r=client.post('/schedule',json=req);assert r.status_code==200
    s=r.json();assert s['llm_mode']=='demo' and not s['needs_human'] and s['receipt']['count']==2 and s['selected'] in ['rule_full','rule_conservative','rule_hold']
    assert 1<=len(s['candidates'])<=3 and len(s['plan'])==24 and s['dispatch_enabled']
    assert all(p['timestamp']==row['t'] for p in [s['plan'][0]])
    assert s['context_source']=='historical_replay'
    assert len((tmp/'logs/dispatch.jsonl').read_text().splitlines())==2
    r=client.post('/chat',json={'scenario':'normal','origin':row['t'],'question':'未来24小时峰值在几点、多少kW？'})
    assert r.status_code==200;out=r.json()
    assert out['llm_mode']=='demo' and out['known'] and out['grounded'] and not out['llm_called']
    assert [x['tool'] for x in out['tool_trace']]==['get_forecast','forecast_peak']
    assert out['tool_trace'][1]['result']['peak_kw']==round(max(p['point_kw'] for p in row['forecast_24h']),1)
    # /chat is read-only, not another two dispatch entries.
    assert len((tmp/'logs/dispatch.jsonl').read_text().splitlines())==2


def test_chat_what_if_calls_simulation_twice_and_unknown(offline):
    data,tmp=offline;row=data['hours'][12]
    # Controlled accepted forecast fixture for numericwhat-if; do not turn production refusals off.
    for p in row['forecast_24h']:p['abstain']=False
    request={'scenario':'normal','origin':row['t'],'question':'空调改成26度能省多少电费'}
    out=client.post('/chat',json=request).json()
    assert out['known'] and out['grounded'] and out['llm_mode']=='demo'
    tools={t['tool']:t['result'] for t in out['tool_trace']}
    assert 'simulate_schedule_before' in tools and 'simulate_schedule_after' in tools
    assert tools['compare_costs']['savings_cny']==round(tools['simulate_schedule_before']['estimated_cost']-tools['simulate_schedule_after']['estimated_cost'],1)
    assert '预计' in out['answer'] and '可自动调度' in out['answer']
    from src.agent.tools import tool_config
    tariff=tool_config()['tariff'];before=tools['simulate_schedule_before'];after=tools['simulate_schedule_after']
    for sim in (before,after):
        assert sim['estimated_cost']==sum(h['cost'] for h in sim['hours'])
        for h in sim['hours']:
            hour=datetime.fromisoformat(h['timestamp']).hour
            period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
            assert h['cost']==h['grid_kwh']*tariff[period]
    assert not any(w in out['answer'] for w in ('线性计算','非实测','不是实测','推算','沿用'))
    unknown=client.post('/chat',json={**request,'question':'这个楼的业主叫什么？'}).json()
    # 72f8c2b: standardized local no-data punctuation.
    assert unknown['answer']=='这个信息系统里没有。' and unknown['reason']=='no_data' and not unknown['known'] and unknown['grounded']
    assert not (tmp/'logs/dispatch.jsonl').exists()


def test_chat_unsafe_temperature_never_simulates_or_dispatches(offline):
    data,tmp=offline;row=data['hours'][12]
    unsafe=client.post('/chat',json={'scenario':'normal','origin':row['t'],'question':'空调改成99度能省多少电费'}).json()
    assert '超出允许范围' in unsafe['answer'] and '本次未调整设备' in unsafe['answer'] and unsafe['reason']=='answered' and not unsafe['known']
    assert not any(t['tool'].startswith('simulate_schedule') for t in unsafe['tool_trace'])
    assert not (tmp/'logs/dispatch.jsonl').exists()


def test_chat_refusal_does_not_invent_full_horizon_savings(offline):
    data,tmp=offline;row=data['hours'][12];row['forecast_24h'][0]['abstain']=True
    out=client.post('/chat',json={'scenario':'normal','origin':row['t'],'question':'空调改成26度能省多少电费'}).json()
    assert out['known'] and '不按整天计算' in out['answer'] and '未计入时段' in out['answer']
    assert out['needs_human'] and out['grounded']
    assert all(t['result']['estimated_cost'] is not None for t in out['tool_trace'] if t['tool'].startswith('simulate_schedule'))
    compare=out['tool_trace'][-1]['result']
    assert compare['accepted_hours']+compare['excluded_hours']==24 and compare['excluded_hours']>0


def test_schedule_handoff_never_dispatches_and_chat_requires_known_origin(offline,monkeypatch):
    _,tmp=offline
    data=load_replay('abstain');row=data['hours'][12]
    assert row['abstain'] and row['agent']['status']=='handoff'
    monkeypatch.setattr(api,'replay_scenario',lambda name:copy.deepcopy(data))
    req={'building_id':data['meta']['building_id'],'scenario':'abstain','start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    r=client.post('/schedule',json=req);assert r.status_code==200
    assert r.json()['needs_human'] and r.json()['receipt']['count']==0 and r.json()['work_orders']
    assert 'llm_mode' in r.json() and not (tmp/'logs/dispatch.jsonl').exists()
    assert client.post('/chat',json={'origin':'2017-01-01T00:00:00Z','question':'未来24小时峰值'}).status_code==422
    assert client.post('/chat',json={'origin':'2017-10-23T12:30:00-05:00','question':'未来24小时峰值'}).status_code==422


def test_chat_grounding_failure_returns_unknown(monkeypatch):
    data=load_replay('normal')
    from src.agent import chat_tools
    monkeypatch.setattr(chat_tools,'check_grounding',lambda *a:False)
    out=answer('未来24小时峰值',data,data['hours'][12])
    assert out['answer']=='这个数现在查不到。' and not out['known']
