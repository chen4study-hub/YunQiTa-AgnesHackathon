import threading
import time
import pytest
from src.agent import chat_topic_hook as hook, topic_guard
from src.agent.chat_engine import consume
from src.agent.building_tools import execute_choice
from src.data.replay_payload import load_replay
from tests.test_chat_local_gate import pipeline


@pytest.mark.parametrize('category',['politics','none'])
def test_next_same_session_waits_prior_verdict_before_starting_pipeline(monkeypatch,category):
    release=threading.Event();entered=threading.Event();tools=[];audit=[]
    monkeypatch.setattr(topic_guard,'_TERMINATED',set())
    monkeypatch.setattr(topic_guard,'record_chat_event',lambda *a,**kw:audit.append(a))
    calls=[]
    def classify(q,*a,**kw):
        calls.append(q)
        if q=='mixed':
            entered.set();assert release.wait(2)
        return {'category':category if q=='mixed' else 'none','reason':'test'}
    monkeypatch.setattr(topic_guard,'classify_topic',classify)
    first=consume(hook.guarded_events('mixed',[],'pending-session',pipeline(),object()))
    assert entered.wait(1) and first['classification_pending']
    def next_pipeline():
        tools.append('ran');return pipeline()()
    result=[]
    def second():result.append(consume(hook.guarded_events('next',[],'pending-session',next_pipeline,object())))
    worker=threading.Thread(target=second);worker.start()
    try:
        time.sleep(.05);assert worker.is_alive() and not tools and calls==['mixed']
    finally:release.set();worker.join(2)
    assert not worker.is_alive()
    if category=='politics':
        assert result[0]['terminated'] and result[0]['answer']=='会话已终止，请开启新会话。'
        assert not tools and len(audit)==1 and calls==['mixed']
    else:
        assert not result[0]['terminated'] and tools==['ran'] and calls==['mixed','next']


@pytest.mark.parametrize('clock,current,next_start,next_price',[
    ('19:30','1.20','20:00','0.75'),('06:30','0.35','07:00','0.75'),
    ('23:30','0.75','次日 00:00','0.35'),('10:00','1.20','20:00','0.75')])
def test_now_tariff_only_current_and_next_band(clock,current,next_start,next_price):
    d=load_replay('normal');out=execute_choice({'tool':'tariff_periods'},'现在电价多少？',d,d['hours'][19],'2026-10-13',clock)
    text=out['answer']
    assert f'现在 {clock}' in text and f'{current} 元/kWh' in text
    assert f'从 {next_start} 开始' in text and f'{next_price} 元/kWh' in text
    assert '最高' not in text and '最低' not in text and 'hour_cost' not in str(out['tool_trace'])
