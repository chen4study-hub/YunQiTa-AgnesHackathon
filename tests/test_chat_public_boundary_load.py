import threading
import time
import pytest
from src.agent import chat_topic_hook as hook,chat_engine,chat_router,chat_tools
from src.agent.chat_display import reading_text
from src.data.replay_payload import load_replay


@pytest.mark.parametrize('tool',['web_search','city_weather'])
def test_rejected_topic_never_executes_public_tool(monkeypatch,tool):
    executed=[]
    monkeypatch.setattr(hook.topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**kw):
        time.sleep(.02)
        return {'category':'politics','reason':'test'}
    monkeypatch.setattr(hook.topic_guard,'classify_topic',classify)
    monkeypatch.setattr(hook.topic_guard,'mark_terminated',lambda *a,**kw:None)
    def pipeline():
        yield {'type':'tool_start','tool':tool,'args':{'query':'中美关系'}}
        executed.append(tool)
        yield {'type':'tool_end','tool':tool,'summary':'unsafe'}
    events=list(hook.guarded_events('中美关系',[],'s',pipeline,object()))
    assert not executed and events[-1]['terminated']
    assert not any(e['type'].startswith('tool') for e in events)


def test_local_read_runs_but_result_is_held(monkeypatch):
    release=threading.Event();read=[]
    monkeypatch.setattr(hook.topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**kw):
        release.wait(1)
        return {'category':'politics','reason':'test'}
    monkeypatch.setattr(hook.topic_guard,'classify_topic',classify)
    monkeypatch.setattr(hook.topic_guard,'mark_terminated',lambda *a,**kw:None)
    def pipeline():
        yield {'type':'tool_start','tool':'current_energy','args':{}}
        read.append(True)
        yield {'type':'tool_end','tool':'current_energy','summary':'must hold'}
        yield {'type':'answer_delta','text':'must hold'}
        release.set()
        yield {'type':'done'}
    events=list(hook.guarded_events('political',[],'s',pipeline,object()))
    assert read and events[0]['type']=='tool_start'
    # ebbf7dd publishes local tool completion before policy; answer stays gated.
    assert [e['tool'] for e in events if e['type']=='tool_end']==['current_energy']
    assert not any(e.get('text')=='must hold' for e in events)
    assert events[-1]['terminated'] and events[-1]['category']=='politics'


def test_accepted_topic_executes_public_tool_after_decision(monkeypatch):
    approved=threading.Event();executed=[]
    monkeypatch.setattr(hook.topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**kw):
        time.sleep(.01);approved.set()
        return {'category':'none','reason':'test'}
    monkeypatch.setattr(hook.topic_guard,'classify_topic',classify)
    def pipeline():
        yield {'type':'tool_start','tool':'web_search','args':{}}
        assert approved.is_set()
        executed.append(True)
        yield {'type':'done'}
    assert list(hook.guarded_events('q',[],'s',pipeline,object()))[-1]['category']=='none'
    assert executed


@pytest.mark.parametrize('question',['现在的总负荷是多少','当前总负荷是多少','现在楼宇用电功率多少'])
def test_total_load_deterministic_snapshot_and_not_grid_import(monkeypatch,question):
    monkeypatch.setenv('LLM_MODE','real')
    class Never:
        def chat_call(self,*a):pytest.fail('never select or reinterpret this reading')
        def chat_stream(self,*a):pytest.fail('never invent definition of total load')
    data=load_replay('normal')
    answers=[chat_engine.consume(chat_engine.events(question,data,data['hours'][14],Never())) for _ in range(2)]
    assert answers[0]['answer']==answers[1]['answer']=='当前楼宇总用电功率 1,258.1 kW。'
    assert answers[0]['tool_trace'][0]['tool']=='building_state'
    assert answers[0]['tool_trace'][0]['result']['actual_kw']==data['hours'][14]['actual_kw']
    assert '820.1' not in answers[0]['answer'] and 'kWh' not in answers[0]['answer']


def test_reading_precision_not_dates_urls_clocks_or_counts():
    raw='26 °C，13,640 kWh，40%，降水 0 mm；14:00，2026-10-13，2 条，3 层。https://example.org/26.0?q=40'
    assert reading_text(raw)=='26.0 °C，13,640.0 kWh，40.0%，降水 0.0 mm；14:00，2026-10-13，2 条，3 层。https://example.org/26.0?q=40'


def test_no_generic_step_and_same_sse_json_precision(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    d=load_replay('normal');events=[];g=chat_engine.events('现在用电情况如何',d,d['hours'][14],display_date='2026-10-13',display_time='14:00')
    while True:
        try:events.append(next(g))
        except StopIteration as end:out=end.value;break
    assert '13,640.0 kWh' in out['answer'] and ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    assert not any(e['type']=='step' and e.get('text')=='正在查询相关数据…' for e in events)
