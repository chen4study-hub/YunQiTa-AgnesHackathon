import time, threading
import pytest
from src.agent import chat_topic_hook as hook, topic_guard, agent_runner as runner
from tests.test_agent_v3 import fixture


@pytest.mark.parametrize('tool',['tariff_periods','storage_history'])
def test_tool_end_not_held_by_classifier_or_next_model_request(monkeypatch,tool):
    release=threading.Event();classified=threading.Event();ended=[]
    monkeypatch.setattr(topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**k):
        assert release.wait(2)
        classified.set();return {'category':'none','reason':'safe'}
    monkeypatch.setattr(topic_guard,'classify_topic',classify)
    def pipeline():
        yield {'type':'tool_start','tool':tool,'id':'t'}
        time.sleep(.025);ended.append(time.monotonic())
        yield {'type':'tool_end','tool':tool,'id':'t','ms':25.0,'summary':'查询完成。'}
        assert release.wait(2)
        yield {'type':'answer_delta','text':'回答。','sentence_source':'llm'}
        yield {'type':'done','known':True}
        return {'answer':'回答。','known':True,'grounded':True}
    g=hook.guarded_events('本楼查询',[],None,pipeline,object())
    assert next(g)['type']=='tool_start'
    event=next(g);received=time.monotonic()
    assert event['type']=='tool_end' and received-ended[0]<.08
    assert not classified.is_set()
    release.set();list(g)


def test_prefetch_fast_tool_end_before_slow_tool_and_records_stable(monkeypatch):
    ended={};started={};received={}
    def run(name,*args):
        started[name]=time.monotonic()
        time.sleep(.20 if name=='tariff_periods' else .025)
        ended[name]=time.monotonic()
        return {'success':True,'trace':[],'reference':name,'evidence':{},'data':{},'needs_human':False}
    monkeypatch.setattr(runner,'run_tool',run)
    d,r=fixture();records=[];timings=[];public_starts={};order=[]
    choices=[{'name':n,'args':{},'question':'本楼'} for n in ('tariff_periods','storage_history')]
    for event in runner.prefetch(choices,d,r,'2026-10-13','14:00',time.monotonic()+2,threading.Event(),runner.ProgressClock(),records,timings):
        if event['type']=='tool_start':public_starts[event['tool']]=time.monotonic()
        if event['type']=='tool_end':
            n=event['tool'];received[n]=time.monotonic();order.append(n)
            assert received[n]-ended[n]<.08
            assert abs(event['ms']-(ended[n]-started[n])*1000)<10
    assert order==['storage_history','tariff_periods']
    assert all(0<=started[n]-public_starts[n]<.08 for n in started)
    assert [r['reference'] for r in records]==['tariff_periods','storage_history']
    assert not any(t.name.startswith('agent-prefetch') for t in threading.enumerate())
