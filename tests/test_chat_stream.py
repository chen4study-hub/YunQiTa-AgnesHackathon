from src.data.replay_payload import load_replay
import copy
import json
import time
from pathlib import Path
from fastapi.testclient import TestClient
from src.api.app import app
from src.agent import chat_engine,chat_tools
from src.agent.chat import answer

QUESTIONS=['为什么这样调度','为什么转人工','执行回执是什么','现在储能SOC多少','未来24小时峰值在几点','空调改26度能省多少电费']


def fixture():
    d=load_replay('normal');return d,d['hours'][14]


class Fake:
    def chat_call(self,phase,payload,feedback=''):
        if phase=='select':
            tool,temp=chat_tools.intent(payload['question']);result={'tool':tool,'setpoint_c':temp}
        else:result={'answer':payload['grounded_reference']}
        return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}


def test_six_questions_tool_order_done_and_current_handoff_scope(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    expected=['selection_reason','handoff_reason','execution_receipt','current_state','get_forecast','get_forecast']
    for q,tool in zip(QUESTIONS,expected):
        d,r=fixture();g=chat_engine.events(q,d,r);t=time.monotonic();first=next(g)
        assert time.monotonic()-t<1 and first['type']=='tool_start'
        out=[first]+list(g);types=[e['type'] for e in out]
        assert out[-1]['type']=='done' and out[-1]['grounded']
        assert out[0]['type']=='tool_start' and out[0]['tool']==tool
        assert types.index('tool_start')<types.index('tool_end')<types.index('answer_delta')<types.index('done')
        assert set(out[-1])=={'type','known','needs_human','grounded','explanation_source','phase_timings','llm_reason','reason','mode'}
        assert out[-1]['explanation_source'] in ('llm','template')
        if tool!='get_forecast':assert out[-1]['known'] and not out[-1]['needs_human']
        for event in out:
            if event['type']=='tool_start':assert set(event)=={'type','tool','args'}
            if event['type']=='tool_end':assert set(event)=={'type','tool','ms','summary'}
    d,r=fixture();result=answer(QUESTIONS[1],d,r,Fake())
    assert '没有转人工' in result['answer'] and not result['needs_human']


def test_origin_local_today_nextday_and_peak_only_handoff(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    d,r=fixture()
    for p in r['forecast_24h']:p['point_kw']=100.;p['abstain']=False
    r['forecast_24h'][0]['point_kw']=999.;r['forecast_24h'][10]['abstain']=True
    out=answer(QUESTIONS[4],d,r);assert '15:00' in out['answer'] and '次日' not in out['answer'] and not out['needs_human']
    r['forecast_24h'][0]['point_kw']=100.;r['forecast_24h'][12]['point_kw']=999.
    out=answer(QUESTIONS[4],d,r);assert '次日' in out['answer'] and not out['needs_human']
    r['forecast_24h'][12]['abstain']=True;out=answer(QUESTIONS[4],d,r);assert out['needs_human']


def test_grounding_failed_step_before_answer_no_unsafe_tokens(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Bad(Fake):
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':return super().chat_call(phase,payload,feedback)
            return {'result':{'answer':'SOC999999.9%'},'llm':{'mode':'real','reason':'call_succeeded'}}
    d,r=fixture();events=list(chat_engine.events(QUESTIONS[3],d,r,Bad()))
    reads=[i for i,e in enumerate(events) if e['type']=='step' and e.get('text')=='正在查询相关数据…']
    assert not reads
    assert next(i for i,e in enumerate(events) if e['type']=='tool_start')<next(i for i,e in enumerate(events) if e['type']=='answer_delta')
    assert '999999.9' not in json.dumps(events)
    assert events[-1]['known'] and events[-1]['grounded'] and not events[-1]['needs_human']


def test_bounded_provider_wait_keeps_calls_bounded():
    import threading
    gate=threading.Event()
    class Slow:
        def chat_call(self,*args):gate.wait(1);return {'result':None,'llm':{'mode':'rule'}}
    start=time.monotonic();out=chat_engine.bounded_call(Slow(),'select',{},'',.03)
    assert time.monotonic()-start<.15 and out['llm']['reason']=='chat_deadline'
    gate.set()


def test_stream_wire_and_error_contract(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    client=TestClient(app);d,r=fixture()
    with client.stream('POST','/chat/stream',json={'origin':r['t'],'scenario':'normal','question':QUESTIONS[3]}) as response:
        assert response.status_code==200 and response.headers['content-type'].startswith('text/event-stream')
        lines=[x for x in response.iter_lines() if x]
    events=[json.loads(line.removeprefix('data: ')) for line in lines]
    assert events[0]['type']=='tool_start' and events[-1]['type']=='done'
    response=client.post('/chat/stream',json={'origin':'2017-01-01T00:00:00Z','question':QUESTIONS[0]})
    e=[json.loads(x.removeprefix('data: ')) for x in response.text.splitlines() if x]
    assert [x['type'] for x in e]==['error','done'] and not e[-1]['needs_human']
