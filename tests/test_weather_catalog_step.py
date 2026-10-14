import pytest
from src.agent.chat_router import route_events
from src.agent.chat_tools import intent
from src.agent.chat_engine import consume
from src.data.replay_payload import load_replay
from src.agent import web_search

QUESTIONS=['今天北京的天气新闻有哪些？给出来源链接','上海今天的天气怎么样？请附来源','查一下深圳最新的天气新闻和链接','伦敦现在气温多少？']

@pytest.mark.parametrize('q',QUESTIONS)
def test_remote_weather_uses_native_public_tools_not_local(monkeypatch,q):
    from tests.test_public_native_search import Native,call,collect
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:dict(status='ok',sources=[
        dict(title='城市天气报道',url='https://example.org/weather',snippet='测试报道')]))
    model=Native([call(q),{'content':'请参考城市天气报道。'}])
    d=load_replay('normal');r,events=collect(route_events(q,d,d['hours'][14],model))
    assert r['tool_trace'][0]['tool']=='web_search'
    assert '当前室外' not in r['answer'] and 'https://example.org/weather' in r['answer']
    assert [e['text'] for e in events if e['type']=='step']==['正在联网查询…']
    assert len(model.requests)==2

@pytest.mark.parametrize('q',['天气怎么样','本楼当前天气如何','云栖塔现在室外气温多少','当前湿度多少'])
def test_local_current_weather_remains_direct(q):
    assert intent(q)[0]=='get_weather'

@pytest.mark.parametrize('q',['北京湿度多少','今天的天气新闻','天气来源链接','明天本楼天气怎么样','温湿度传感器的原理'])
def test_ambiguous_weather_not_fast(q):
    assert intent(q)[0]!='get_weather'

def test_idle_chat_no_step(monkeypatch):
    class Fake:
        def chat_call(self,*a,**kw):return dict(result=dict(answer='你好。'),llm=dict(mode='real',reason='call_succeeded'))
    assert not any(e['type']=='step' for e in route_events('讲个笑话',{}, {},Fake()))

def test_steps_have_no_internal_or_banned_words(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');row=d['hours'][14]
    for q in ['现在几点','天气怎么样','今天有哪些告警','为什么这样调度']:
        steps=[e['text'] for e in route_events(q,d,row) if e['type']=='step']
        assert steps and all(t=='正在查询相关数据…' for t in steps)


def test_api_stream_does_not_prepend_universal_step(monkeypatch):
    from fastapi.testclient import TestClient
    from src.api import app as api
    import json
    from datetime import datetime,timezone
    monkeypatch.setattr(api,'replay_hour',lambda *a:({},{}))
    def idle(*a,**kw):
        yield {'type':'answer_delta','text':'你好。'}
        yield {'type':'done','known':True,'grounded':True,'needs_human':False}
    monkeypatch.setattr(api,'chat_events',idle)
    with TestClient(api.app) as c:
        response=c.post('/chat/stream',json={'question':'你好','origin':'2017-10-23T14:00:00-05:00'})
        events=[json.loads(l[6:]) for l in response.text.splitlines() if l.startswith('data: ')]
    assert not any(e['type']=='step' for e in events)


def test_indoor_humidity_never_forced_into_public_weather_route(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:pytest.fail('indoor needs building tool'))
    d=load_replay('normal');r=consume(route_events('室内湿度多少',d,d['hours'][14]))
    assert r['known'] and r['tool_trace'][0]['tool']=='building_state'


def test_building_postprocess_also_removes_internal_host_words():
    from src.agent.display_text import render_public_fields
    assert render_public_fields({'answer':'当前空调设定 25.5 °C。来源链接请参考宿主附上的公开资料。'})['answer']=='当前空调设定 25.5 °C。'
