from src.data.replay_payload import load_replay
import json,time
from pathlib import Path
import pytest,httpx
from src.agent import chat_engine,provider
from src.agent.chat import answer
from src.agent.chat_tools import intent
from src.agent.display_text import wording_text
from src.agent.chat_sentence_stream import stream_answer


def fixture():
    d=load_replay('normal');return d,d['hours'][14]


@pytest.mark.parametrize('q',['为什么这样调度','为什么转人工','执行回执是什么','未来24小时峰值什么时候','现在储能电量多少','现在几点','天气怎么样','空调改26度电费多少'])
def test_common_tool_never_waits_for_llm_selection(monkeypatch,q):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_call(self,*a):pytest.fail('known intent must not call selection')
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':payload['grounded_reference']}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer(q,d,row,Fake(),display_time='13:44',display_date='2026-10-12')
    assert r['known'] and r['grounded']
    if intent(q)[0] in ('get_time','get_weather'):
        assert r['explanation_source']=='template' and not r['llm_called'] and r['phase_timings']==[]
    else:
        assert r['explanation_source']=='llm' and r['phase_timings'][0]['phase']=='answer_stream'


def test_unknown_still_selects_and_unsupported_never_invents(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        calls=0
        def chat_call(self,phase,payload,feedback=''):
            self.calls+=1;assert phase=='select'
            return {'result':{'tool':'unknown','setpoint_c':None},'llm':{'mode':'real','reason':'call_succeeded'}}
        def chat_stream(self,payload):pytest.fail('unknown facts must not compose')
    p=Fake();r=answer('业主是谁',d,row,p)
    # 72f8c2b: no-data copy includes a full stop.
    assert not r['known'] and r['answer']=='这个信息系统里没有。' and r['reason']=='no_data'
    assert p.calls==0 and not r['llm_called']


def test_sentence_immediate_before_stream_finishes_no_raw_unsourced(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        released=False
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':'当前室外 13'}
            yield {'type':'text_delta','text':'.3 °C，湿度 57%。'}
            deadline=time.monotonic()+1
            while not self.released and time.monotonic()<deadline:time.sleep(.001)
            assert self.released  # consumer must see first checked sentence NOW
            yield {'type':'text_delta','text':'电费999999.9元。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    # Exercise the sentence gate directly; weather questions now bypass the provider.
    row['weather']['outdoor_temp_c']=13.3;row['weather']['relative_humidity_pct']=57.2
    from src.agent.chat_tools import execute
    result=chat_engine.consume(execute('get_weather','天气怎么样',d,row))
    p=Fake();g=stream_answer(p,'天气怎么样','get_weather',result,row,time.monotonic()+3);events=[]
    while True:
        try:
            e=next(g);events.append(e)
            if e['type']=='answer_delta':p.released=True
        except StopIteration as end:r=end.value;break
    assert p.released and '999999' not in json.dumps(events)
    assert r['llm']['dropped_sentences']==1 and r['answer']=='当前室外 13.3 °C，湿度 57%。'


def test_missing_receipt_values_host_supplements_once_no_second_llm(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # Deliberately nonzero receipt; current offline exports have no dispatch.
    row['agent']['receipt'].update(count=2,elapsed_ms=1.4)
    class Fake:
        def chat_stream(self,payload):
            assert payload['required_answer_text']==['BA/EMS','日志回执']
            assert len(payload['required_answer_values'])==2
            assert payload['tools']['tools'][0]['result']['dispatch_target']=='BA/EMS'
            yield {'type':'text_delta','text':'BA/EMS下发日志回执已记录。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    g=chat_engine.events('执行回执是什么',d,row,Fake());events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:r=end.value;break
    assert r['explanation_source']=='llm' and r['llm']['host_supplemented']
    # 72f8c2b removes generic query narration, preserving actual tool order.
    assert not any(e['type']=='step' for e in events)
    assert events[0]['type']=='tool_start' and events[0]['tool']=='execution_receipt'
    assert r['answer'].count('2 条指令')==1 and '1.4 毫秒' in r['answer']


def test_partial_stream_failure_no_duplicate_no_unsafe_tail(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':'BA/EMS日志回执已记录。设备已执行'}
            raise httpx.ReadTimeout('private unsafe response')
    r=answer('执行回执是什么',d,row,Fake())
    assert r['explanation_source']=='llm' and '设备已执行' not in r['answer']
    assert r['llm']['reason']=='chat_provider_failed' and r['llm']['host_supplemented']


def test_upstream_sse_content_not_structured_tool_buffer(monkeypatch):
    captured=[]
    class Response:
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def raise_for_status(self):pass
        def iter_lines(self):
            yield 'data: '+json.dumps({'choices':[{'delta':{'content':'现在 13:44。'},'finish_reason':None}]})
            yield 'data: [DONE]'
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def stream(self,*a,**kwargs):captured.append(kwargs['json']);return Response()
    monkeypatch.setattr(provider,'get_llm_status',lambda:{'mode':'real'});monkeypatch.setattr(provider,'read_key',lambda:('fixture-credential','available'))
    monkeypatch.setattr(provider.httpx,'Client',Client)
    events=list(provider.OpenAICompatibleProvider().chat_stream({'_wait_seconds':5}))
    assert events[0]['text']=='现在 13:44。' and events[-1]['llm']['reason']=='call_succeeded'
    assert captured[0]['stream'] is True and 'tools' not in captured[0]


def test_host_supplement_power_units_and_only_missing_cost_difference():
    from src.agent.chat_sentence_stream import host_supplement
    text=host_supplement('selection_reason',{},[{'value':1179.9,'meaning':'区间上界电网峰值(kW)'}],False)
    assert 'kW' in text
    r={'tool_trace':[{'result':{'before_setpoint_c':25.5,'after_setpoint_c':26.,'before_cost':100.,'after_cost':90.,'savings_cny':10.,'before_peak_kw':50.,'after_peak_kw':45.,'peak_increase_kw':0.,'peak_reduction_kw':5.,'extra_cost_cny':0.,'accepted_hours':21,'excluded_hours':0,'excluded':[]}}]}
    text=host_supplement('hvac_compare',r,[{'value':10.,'meaning':'差额'}],False,'接受21小时、排除0小时，非全天口径。')
    assert '10.0 元' in text and '25.5' not in text and '100.0' not in text


def test_stream_bad_dates_and_unit_reassignments_never_emitted(monkeypatch):
    from src.agent.chat_sentence_stream import safe_sentence
    d,row=fixture();result={'answer':'今天是 10 月 12 日。','needs_human':False}
    evidence={'tools':[{'hour':13,'minute':44,'month':10,'day':12}]}
    assert not safe_sentence('今天是13月44日。','get_time',result,row,evidence)
    result={'tool_trace':[{'result':{'savings_cny':10.}}],'needs_human':False}
    assert not safe_sentence('仅接受时段、非全天，预计节省 0.4 元。','hvac_compare',result,row,{'risk_score':.4,'savings_cny':10.})


@pytest.mark.parametrize('code,calls',[(500,2),(401,1),(429,1),(502,1)])
def test_stream_fast500_only_retry_no_content_replay(monkeypatch,code,calls):
    class Response:
        def __init__(self,status):self.status=status
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def raise_for_status(self):
            if self.status!=200:raise httpx.HTTPStatusError('private body',request=httpx.Request('POST','https://example.invalid'),response=httpx.Response(self.status))
        def iter_lines(self):
            yield 'data: '+json.dumps({'choices':[{'delta':{'content':'现在 13:44。'}}]})
            yield 'data: [DONE]'
    class Client:
        count=0
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def stream(self,*a,**k):
            Client.count+=1;return Response(code if Client.count==1 else 200)
    monkeypatch.setattr(provider,'get_llm_status',lambda:{'mode':'real'});monkeypatch.setattr(provider,'read_key',lambda:('fixture-credential','available'))
    monkeypatch.setattr(provider.httpx,'Client',Client);monkeypatch.setattr(provider.time,'sleep',lambda s:None)
    r=list(provider.OpenAICompatibleProvider().chat_stream({'_wait_seconds':5}))
    assert Client.count==calls and 'private' not in json.dumps(r)


def test_json_sse_join_same_and_multi_sentence_no_duplicate(monkeypatch):
    from fastapi.testclient import TestClient
    from src.api import app as api
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':payload['grounded_reference']}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake);monkeypatch.setattr(api,'replay_hour',lambda *a:(d,row))
    c=TestClient(api.app);q={'question':'现在几点、天气怎么样？','origin':row['t'],'display_time':'13:44'}
    out=c.post('/chat',json=q).json();events=[json.loads(l[6:]) for l in c.post('/chat/stream',json=q).text.splitlines() if l.startswith('data: ')]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    assert out['answer'].count('13:44')==1 and out['explanation_source']=='template'
    assert not out['llm_called']


def test_operator_wording_no_internal_rules_duplicate_refusal():
    text='峰值容差内视为相同并优先比较电费，上界峰值 1000.0 kW，电费 2000.0 元；不为不可见的峰值微差增加支出。储能按完整窗口统筹，为今天 15:00峰段留电；窗口末电量不低于起点，每小时只执行首步后重规划。后续今天 17:00预测被拒绝，已保持设定且不充放电。后续时段预测被拒绝，保留电量等值班人员复核后使用。'
    clean=wording_text(text)
    assert all(w not in clean for w in ['容差','微差','首步','重规划'])
    assert clean.count('预测被拒绝')==1 and '； ' not in clean
