"""Frozen-release fixes: local/public boundary, no-data identities, worker errors."""
import json
import time
import threading
import pytest
from src.agent import chat_engine
from src.agent.chat import answer
from src.agent.chat_engine import consume
from src.agent.general_chat import events as public_events
from src.data.replay_payload import load_replay


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    data=load_replay('normal')
    return data,data['hours'][12]


@pytest.mark.parametrize('question',['未来负荷最大是什么时候？','未来24小时峰值是多少？','今天电费是多少？','现在储能电量是多少？','未来储能电量趋势是什么？','联网查询本楼未来负荷最大是什么时候？'])
def test_local_readings_never_use_general_or_public_model(local,question):
    data,row=local
    class Fake:
        phases=[]
        def chat_call(self,phase,payload,feedback=''):
            self.phases.append(phase)
            assert phase not in ('general','select')
            if phase=='route':
                return {'result':{'choices':[{'tool':'general_chat','parameters':{}}]},'llm':{'mode':'real','reason':'call_succeeded'}}
            return {'result':{'answer':'峰值999999.9 kW。电费999999.9元。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    fake=Fake();out=answer(question,data,row,fake)
    assert out['grounded'] and '999999' not in out['answer']
    assert not any(t['tool'] in ('web_search','city_weather','general_chat') for t in out['tool_trace'])
    assert out['answer_source']=='deterministic_tools'


@pytest.mark.parametrize('question',['业主是谁','本楼业主叫什么？','这个楼的物业叫什么？','云栖塔物业电话是多少？'])
@pytest.mark.parametrize('mode',['demo','real'])
def test_identity_has_no_data_without_any_provider_wait(monkeypatch,local,question,mode):
    data,row=local;monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    class Never:
        def chat_call(self,*a):pytest.fail('local identities must not call a provider')
        def chat_stream(self,*a):pytest.fail('local identities must not stream')
    events=[];g=chat_engine.events(question,data,row,Never())
    while True:
        try:events.append(next(g))
        except StopIteration as end:out=end.value;break
    assert out['answer']=='这个信息系统里没有。' and out['reason']=='no_data'
    assert not out['known'] and out['grounded'] and not out['llm_called'] and out['tool_trace']==[]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    assert events[-1]['type']=='done' and events[-1]['reason']=='no_data'
    assert not any(e['type'] in ('progress','tool_start') for e in events)


@pytest.mark.parametrize('stream',[False,True])
@pytest.mark.parametrize('text',['峰值999999.9 kW。','本楼未来负荷峰值为999999.9 kW。','本楼电费为999999.9元','当前储能电量为999999.9%。'])
def test_public_path_cannot_emit_local_numeric_claims(stream,text):
    class Fake:
        def chat_call(self,*a):return {'result':{'answer':text},'llm':{'mode':'real','reason':'call_succeeded'}}
    class Streaming(Fake):
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':text}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    events=[];g=public_events('请说一句普通常识',Streaming() if stream else Fake())
    while True:
        try:events.append(next(g))
        except StopIteration as end:out=end.value;break
    assert '999999' not in json.dumps(events,ensure_ascii=False)+out['answer']
    assert out['grounded'] and not out['known']


@pytest.mark.parametrize('kind',['assertion','pytest_fail'])
@pytest.mark.parametrize('path',['bounded','public','local_stream'])
def test_worker_failures_are_raised_in_consumer_thread(local,kind,path):
    data,row=local;consumer=threading.get_ident();workers=[]
    def fail():
        workers.append(threading.get_ident())
        if kind=='assertion':raise AssertionError('fake provider invariant')
        pytest.fail('fake provider invariant')
    class Fake:
        def chat_call(self,*a):fail()
        def chat_stream(self,*a):fail()
    error=AssertionError if kind=='assertion' else pytest.fail.Exception
    with pytest.raises(error,match='fake provider invariant'):
        if path=='bounded':chat_engine.bounded_call(Fake(),'answer',{},'',2.)
        elif path=='public':consume(public_events('说一句常识',Fake()))
        else:answer('现在储能电量多少',data,row,Fake())
    assert workers and all(worker!=consumer for worker in workers)
