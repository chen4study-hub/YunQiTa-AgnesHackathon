import copy
import pytest
from src.agent.chat import answer
from src.agent import chat_engine
from src.agent.chat_tools import execute
from src.data.replay_payload import load_replay
from src.agent.display_text import render_public_fields,compact_time_text
from tests.test_takeover_agent import repo,record


def test_live_takeover_chat_record(repo,monkeypatch):
    record(repo,14)
    d=load_replay('normal');d['meta']['building_id']='A';row=d['hours'][14]
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    for q in ['为什么转人工','现在谁在接管']:
        r=answer(q,d,row,display_date='2026-10-12',display_time='14:00')
        assert r['known'] and r['grounded'] and r['needs_human'],r
        assert '值班员甲' in r['answer'] and '26.0 °C' in r['answer']
        assert '50.0 kW' in r['answer'] and '门控' not in r['answer']
        assert r['tool_trace'][0]['result']['active_takeover']['operator_id']=='值班员甲'


def test_storage_partial_only_supplements_missing_required(repo,monkeypatch):
    d=load_replay('normal');row=d['hours'][14]
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Partial:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':f"当前储能电量 {row['storage']['soc']*100:.1f}%。"}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('储能还剩多少电',d,row,Partial())
    assert r['answer'].count(f"{row['storage']['soc']*100:.1f}")==1 and '气温' not in r['answer'] and '空调设定' not in r['answer']
    assert not r['llm']['host_supplemented']


def test_alert_asset_ids_chinese(repo,monkeypatch):
    from src.agent.building_tools import execute_choice
    from src.agent import building_tools
    original=building_tools.load
    def fixture_load(*args):
        data,path=original(*args);data=copy.deepcopy(data)
        data['alerts']=[dict(offset_ms=19*3600000,asset_id='storage',system='储能',content='电量偏低',status='待核查'),
            dict(offset_ms=11*3600000,asset_id='floor-18-east',system='空调',content='室温超过27°C',status='已恢复')]
        return data,path
    monkeypatch.setattr(building_tools,'load',fixture_load)
    d=load_replay('normal');r=execute_choice({'tool':'alerts_orders'},'今天有哪些告警',d,d['hours'][19], '2026-10-12','19:00')
    assert 'storage' not in r['answer'] and '储能站' in r['answer']
    assert '11:00' in r['answer'] and '层' in r['answer']


def test_units_and_broken_range_idempotent():
    raw={'reason':'次日 10:00–16:00 及 。次日 18:00–19:00；26.0℃，1700kWh。'}
    result=render_public_fields(raw)
    assert '及 。' not in result['reason'] and '26.0 °C' in result['reason'] and '1,700 kWh' in result['reason']
    assert render_public_fields(result)==result
    assert compact_time_text('今天 14:00当前小时回执2条，耗时1.4毫秒。')=='14:00 当前小时回执 2 条，耗时 1.4 毫秒。'


def test_hvac_template_two_or_three_sentences(repo):
    d=load_replay('normal');r=chat_engine.consume(execute('hvac_compare','空调改26度电费多少',d,d['hours'][14],26))
    assert r['known'] and 2<=r['answer'].count('。')<=3
    assert all(w in r['answer'] for w in ['可自动调度','未计入','只覆盖'])


def test_json_sse_takeover_parity_and_cancellation(repo,monkeypatch):
    from fastapi.testclient import TestClient
    from src.api import app as api
    import json
    from datetime import datetime,timedelta,timezone
    rec=record(repo,14);d=load_replay('normal');d['meta']['building_id']='A';row=d['hours'][14]
    monkeypatch.setattr(api,'replay_hour',lambda *args:(d,row))
    monkeypatch.setenv('LLM_MODE','demo')
    payload={'question':'现在谁在接管','origin':row['t'],'display_date':'2026-10-12','display_time':'14:00'}
    with TestClient(api.app) as c:
        result=c.post('/chat',json=payload).json()
        with c.stream('POST','/chat/stream',json=payload) as response:
            events=[json.loads(line[6:]) for line in response.iter_lines() if line.startswith('data: ')]
        assert result['answer']==''.join(e['text'] for e in events if e['type']=='answer_delta')
        assert '值班员甲' in result['answer'] and events[-1]['needs_human']
        repo.clock=lambda:datetime(2026,10,12,5,59,tzinfo=timezone.utc)
        repo.cancel(rec['id'],'值班员甲','结束接管')
        after=c.post('/chat',json=payload).json()
        assert not after['tool_trace'][0]['result']['active_takeover']
        assert '没有转人工' in after['answer']
