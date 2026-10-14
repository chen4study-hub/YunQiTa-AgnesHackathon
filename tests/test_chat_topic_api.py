"""Both public endpoints share topic state; no real network/database."""
import json
import threading
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import topic_guard as guard


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setattr(guard,'_TERMINATED',set())
    monkeypatch.setattr(guard,'record_chat_event',lambda *a,**kw: 1)
    monkeypatch.setattr(guard,'classify_topic',lambda question,history,provider,**kw:
        dict(category='politics' if question=='political' else 'current_affairs' if question=='news' else 'none',reason='test'))
    return TestClient(api.app)


def body(question,session_id='isolated'):
    return dict(question=question,session_id=session_id,scenario='normal',origin='2017-10-23T14:00:00-05:00',display_date='2026-10-13',display_time='14:00')


def events(client,question,session_id='isolated'):
    response=client.post('/chat/stream',json=body(question,session_id))
    assert response.status_code==200
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


@pytest.mark.parametrize('first,second',[('/chat','/chat/stream'),('/chat/stream','/chat')])
def test_cross_endpoint_termination_no_data_reads(client,monkeypatch,first,second):
    def no_read(*a):raise AssertionError('terminated sessions must not load data')
    # Initial valid classification runs concurrently with a synthetic v1 pipeline.
    def pipeline(*a,**kw):
        yield dict(type='answer_delta',text='must discard')
        yield dict(type='done',known=True)
        return dict(answer='must discard',known=True)
    monkeypatch.setattr(api,'replay_hour',lambda *a: ({'meta':{'building_id':'b'}},{'t':'t'}))
    monkeypatch.setattr(api,'chat_events',pipeline)
    response=client.post(first,json=body('political'))
    out=response.json() if first=='/chat' else json.loads(response.text.splitlines()[-2][6:])
    assert out['terminated'] and out['category']=='politics'
    assert out['answer']==guard.refusal_message() and out['session_id']=='isolated'
    monkeypatch.setattr(api,'replay_hour',no_read)
    monkeypatch.setattr(guard,'classify_topic',no_read)
    response=client.post(second,json=body('weather'))
    out=response.json() if second=='/chat' else json.loads(response.text.splitlines()[-2][6:])
    assert out['terminated'] and out['category']=='terminated' and out['answer']=='会话已终止，请开启新会话。'


def test_independent_sessions_and_real_time_template(client):
    assert events(client,'news','blocked')[-1]['terminated']
    safe=events(client,'现在几点','safe')
    assert not safe[-1]['terminated'] and safe[-1]['session_id']=='safe'
    assert '14:00' in ''.join(e.get('text','') for e in safe if e['type']=='answer_delta')
    out=client.post('/chat',json=body('天气怎么样','weather')).json()
    assert not out['terminated'] and out['known'] and out['session_id']=='weather' and '°C' in out['answer']


def test_null_and_invalid_session_ids(client):
    out=events(client,'现在几点',None)[-1]
    assert out['session_id'] is None
    for value in ('',' '*4,'x'*129):
        for endpoint in ('/chat','/chat/stream'):
            assert client.post(endpoint,json=body('x',value)).status_code==422


def test_error_done_also_echoes_session(client):
    payload=body('现在几点','error-session');payload['origin']='2017-01-01T00:00:00Z'
    response=client.post('/chat/stream',json=payload)
    out=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert [e['type'] for e in out]==['error','done']
    assert out[-1]['session_id']=='error-session' and not out[-1]['terminated']


def test_classification_provider_is_not_answer_provider(client,monkeypatch):
    seen=[]
    class Provider: pass
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Provider)
    monkeypatch.setattr(api,'TopicClassificationProvider',Provider)
    monkeypatch.setattr(guard,'classify_topic',lambda q,h,p,**kw: seen.append(p) or dict(category='none',reason='test'))
    def pipeline(*a,**kw):
        seen.append(kw['provider'])
        yield dict(type='done',known=True)
        return dict(answer='',known=True)
    monkeypatch.setattr(api,'chat_events',pipeline)
    events(client,'现在几点')
    assert len(seen)==2 and seen[0] is not seen[1]


def test_terminated_stream_bypasses_busy_pool(client,monkeypatch):
    guard._TERMINATED.add('blocked')
    async def busy(*a):
        raise AssertionError('terminated session must bypass admission')
        yield {}
    monkeypatch.setattr(api.chat_pool,'events',busy)
    out=events(client,'现在几点','blocked')
    assert [e['type'] for e in out]==['answer_delta','done']
    assert out[-1]['terminated'] and out[-1]['answer']=='会话已终止，请开启新会话。'


@pytest.mark.parametrize('endpoint',['/chat','/chat/stream'])
def test_actual_timeout_template_mode_is_fallback(client,monkeypatch,endpoint):
    import time
    from src.agent import chat_engine,chat_sentence_stream
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(api,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(chat_sentence_stream,'FIRST_TOKEN_SECONDS',.02)
    class Slow:
        def chat_stream(self,*a):
            time.sleep(.06)
            yield {'type':'text_delta','text':'too late'}
        def cancel_chat(self):pass
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Slow)
    response=client.post(endpoint,json=body('当前能源怎么样'))
    out=response.json() if endpoint=='/chat' else json.loads(response.text.splitlines()[-2][6:])
    assert out['mode']=='fallback' and out['known'] and not out['terminated']
    assert out['explanation_source']=='template'
    time.sleep(.07)
