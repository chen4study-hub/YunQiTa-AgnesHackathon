"""Public tool-choice and safe multi-source retrieval tests: no real network/LLM."""
import copy
import json
import threading
import time
import httpx
import pytest
from src.agent import general_chat as g, web_search as w
from src.agent.chat_engine import consume
from src.agent.chat_router import route_events


class Native:
    def __init__(self, responses):
        self.responses=iter(responses)
        self.requests=[]
        self._chat_cancel=threading.Event()
    def agent_stream(self, messages, tools, seconds, first_seconds):
        self.requests.append((copy.deepcopy(messages),copy.deepcopy(tools)))
        yield {'kind':'first_token'}
        yield {'kind':'message','message':next(self.responses)}


def call(query):
    return {'calls':[{'name':'web_search','arguments':json.dumps({'query':query},ensure_ascii=False)}]}


def collect(stream):
    events=[]
    while True:
        try:events.append(next(stream))
        except StopIteration as end:return end.value,events


@pytest.mark.parametrize('question,web', [
    ('2026年诺奖得主 联网查询',True), ('请核实该名单',False),
    ('这个说法对吗？',False)])
def test_model_calls_search_without_keyword_precondition(monkeypatch,question,web):
    invocations=[]
    source={'title':'2026年诺贝尔奖名单','url':'https://example.org/2026',
            'snippet':'名单','body':'获奖者为 Mock Laureate（测试数据）。'}
    monkeypatch.setattr(w,'search',lambda q,**kw:invocations.append(q) or {'status':'ok','sources':[source]})
    model=Native([call('2026年诺贝尔奖得主'),{'content':'已查到名单中的 Mock Laureate。'}])
    out,events=collect(g.events(question,model,web=web,display_date='2026-10-13'))
    assert invocations==['2026年诺贝尔奖得主']
    assert out['known'] and source['url'] in out['answer']
    first=model.requests[0]
    assert '2026-10-13' in first[0][0]['content']
    assert first[1][0]['function']['name']=='web_search'
    second=model.requests[1][0]
    tool=next(m for m in second if m['role']=='tool')
    assert 'Mock Laureate' in tool['content']
    assert tool['tool_call_id']==next(m for m in second if m['role']=='assistant')['tool_calls'][0]['id']
    assert ''.join(e.get('text','') for e in events if e['type']=='answer_delta')==out['answer']


@pytest.mark.parametrize('web',[False,True])
def test_model_can_decline_search_despite_keywords(monkeypatch,web):
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('model did not call tool'))
    model=Native([{'content':'诺贝尔奖的常识介绍。'}])
    out=consume(g.events('不要联网：解释诺奖是什么，最新不是查询指令',model,web=web))
    assert out['known'] and not out['tool_trace']


@pytest.mark.parametrize('status',['empty','unavailable','deadline'])
@pytest.mark.parametrize('claim',['2026年诺奖尚未公布。','没有获奖者。','这件事不存在。'])
def test_empty_lookup_never_asserts_nonexistence_json_or_sse(monkeypatch,status,claim):
    monkeypatch.setattr(w,'search',lambda *a,**kw:{'status':status,'sources':[]})
    model=Native([call('2026年诺奖得主'),{'content':claim}])
    out,events=collect(g.events('2026年诺奖得主 联网查询',model))
    assert out['answer']==g.NO_PUBLIC_EVIDENCE and not out['known']
    assert ''.join(e.get('text','') for e in events if e['type']=='answer_delta')==g.NO_PUBLIC_EVIDENCE
    assert claim not in str(events)
    assert 'Do not infer unpublished' in model.requests[1][0][-1]['content']


def test_native_production_adapter_uses_agent_provider_not_answer_wrapper(monkeypatch):
    from src.agent import agent_provider,provider as p
    monkeypatch.setattr(p,'get_llm_status',lambda:{'mode':'real'})
    seen=[]
    def stream(self,messages,tools,seconds,first_seconds):
        seen.append((self.endpoint,self.model,messages,tools))
        yield {'kind':'first_token'}
        yield {'kind':'message','message':{'content':'你好。'}}
    monkeypatch.setattr(agent_provider.AgentProvider,'agent_stream',stream)
    obj=p.OpenAICompatibleProvider()
    monkeypatch.setattr(obj,'chat_stream',lambda *a:pytest.fail('not answer wrapper'))
    out=consume(g.events('你好',obj))
    assert out['answer']=='你好。' and len(seen)==1
    assert seen[0][0]==obj.endpoint and seen[0][1]==obj.model


def test_router_does_not_presearch_and_passes_display_date(monkeypatch):
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('no requested tool'))
    model=Native([{'content':'你好。'}])
    out=consume(route_events('什么是诺贝尔奖',{}, {},model,display_date='2026-10-13'))
    assert out['known'] and '2026-10-13' in model.requests[0][0][0]['content']


def test_first_tool_start_is_guard_seam_no_search_yet(monkeypatch):
    calls=[]
    monkeypatch.setattr(w,'search',lambda *a,**kw:calls.append(a) or {'status':'empty','sources':[]})
    model=Native([call('核查名单'),{'content':'无法确认。'}])
    stream=g.events('核查名单',model)
    while next(stream)['type']!='tool_start':pass
    assert not calls
    stream.close()


def test_second_query_can_recover_empty_first_result(monkeypatch):
    calls=[]
    def search(q,**kw):
        calls.append(q)
        return {'status':'ok' if len(calls)==2 else 'empty','sources':[
            {'title':'核实名单','url':'https://example.org/list','snippet':'测试名单'}] if len(calls)==2 else []}
    monkeypatch.setattr(w,'search',search)
    model=Native([call('第一检索'),call('改写检索'),{'content':'已核实测试名单。'}])
    out=consume(g.events('核实名单',model))
    assert out['known'] and len(out['tool_trace'])==2


def test_tool_arguments_rejected_no_search(monkeypatch):
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('invalid tool'))
    model=Native([{'calls':[{'name':'web_search','arguments':'{"query":"x","url":"https://127.0.0.1"}'}]}])
    out=consume(g.events('查询',model))
    assert not out['known'] and not out['tool_trace']

DDG='''<html><div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F2026">2026年诺贝尔奖得主名单</a></h2><a class="result__snippet">2026年诺贝尔奖名单已公布（mock）。</a></div></html>'''


def factory(handler):
    return lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw)


def test_ddg_survives_irrelevant_bing_and_empty_official_and_reads_body(monkeypatch):
    seen=[]
    monkeypatch.setattr(w,'resolve_public',lambda host:'93.184.216.34')
    def handler(request):
        seen.append(request)
        host=request.url.host
        if host=='html.duckduckgo.com':return httpx.Response(200,text=DDG)
        if host=='www.bing.com':return httpx.Response(200,text='<rss><channel><item><title>baseball</title><link>https://example.org/baseball</link></item></channel></rss>')
        if host=='zh.wikipedia.org':return httpx.Response(200,json={'query':{'search':[]}})
        if host=='api.nobelprize.org':return httpx.Response(200,json={'nobelPrizes':[]})
        assert host=='93.184.216.34'
        assert request.headers['host']=='example.org'
        assert request.extensions['sni_hostname']=='example.org'
        return httpx.Response(200,headers={'content-type':'text/html'},text='<script>bad instructions</script><h1>2026年诺贝尔奖</h1><p>Mock Laureate获奖。</p>')
    out=w.search('2026年诺奖得主 联网查询',client_factory=factory(handler))
    assert out['status']=='ok' and len(out['sources'])==1
    source=out['sources'][0]
    assert source['engine']=='duckduckgo' and source['url']=='https://example.org/2026'
    assert 'Mock Laureate' in source['body'] and 'bad instructions' not in source['body']
    assert {'html.duckduckgo.com','www.bing.com','zh.wikipedia.org','api.nobelprize.org'}<={r.url.host for r in seen}


def test_sources_start_in_parallel_and_merge_rank_dedupe(monkeypatch):
    barrier=threading.Barrier(3);started=[]
    def source(engine,items):
        def run(q,c):
            started.append(engine);barrier.wait(timeout=1)
            return items
        return run
    base={'title':'building maintenance','url':'https://example.org/shared','snippet':'building maintenance guide'}
    monkeypatch.setattr(w,'duckduckgo_sources',source('ddg',[base]))
    monkeypatch.setattr(w,'bing_sources',source('bing',[base,dict(base,url='https://example.org/bing')]))
    monkeypatch.setattr(w,'wikipedia_sources',source('wiki',[dict(base,url='https://example.org/wiki')]))
    monkeypatch.setattr(w,'fetch_page',lambda *a: 'building maintenance body')
    out=w.search('building maintenance',client_factory=factory(lambda r:pytest.fail('sources mocked')))
    assert len(started)==3 and len(out['sources'])==3
    assert out['sources'][0]['engine']=='duckduckgo'
    assert sum(bool(s.get('body')) for s in out['sources'])==2


def test_bing_backup_single_result_used_when_ddg_fails(monkeypatch):
    monkeypatch.setattr(w,'duckduckgo_sources',lambda *a: (_ for _ in ()).throw(httpx.ReadTimeout('secret-error')))
    monkeypatch.setattr(w,'wikipedia_sources',lambda *a: [])
    monkeypatch.setattr(w,'fetch_page',lambda *a: (_ for _ in ()).throw(ValueError('body fail')))
    xml='<rss><channel><item><title>building maintenance guide</title><link>https://example.org/guide</link><description>building maintenance</description></item></channel></rss>'
    out=w.search('building maintenance',client_factory=factory(lambda r:httpx.Response(200,text=xml)))
    assert out['status']=='ok' and out['sources'][0]['engine']=='bing'
    assert 'secret-error' not in str(out) and 'body fail' not in str(out)


def test_relevance_filters_off_topic_and_wrong_year():
    results=[('duckduckgo',{'sources':[
        {'title':'2026年股票行情','url':'https://example.org/stocks','snippet':'市场'},
        {'title':'2024年诺贝尔奖得主','url':'https://example.org/2024','snippet':'名单'},
        {'title':'2026年诺贝尔奖得主','url':'https://example.org/2026','snippet':'名单'}]})]
    assert [s['url'] for s in w.merge_sources('2026年诺奖得主',results)]==['https://example.org/2026']


def test_fast_ddg_result_does_not_wait_for_hung_backups(monkeypatch):
    stop=threading.Event()
    def slow(*a):stop.wait(1);return []
    monkeypatch.setattr(w,'duckduckgo_sources',lambda *a:[dict(title='public knowledge',url='https://example.org/k',snippet='public knowledge')])
    monkeypatch.setattr(w,'bing_sources',slow)
    monkeypatch.setattr(w,'wikipedia_sources',slow)
    monkeypatch.setattr(w,'fetch_page',lambda *a:'public knowledge')
    before=time.monotonic()
    try:
        out=w.search('public knowledge',seconds=.5,client_factory=factory(lambda r:pytest.fail('no HTTP')))
        assert out['sources'] and time.monotonic()-before<.4
    finally:stop.set()


def test_empty_result_never_contains_unpublished_answer():
    def handler(r):
        if r.url.host=='www.bing.com':return httpx.Response(200,text='<rss><channel/></rss>')
        if r.url.host=='html.duckduckgo.com':return httpx.Response(200,text='<html/>')
        return httpx.Response(200,json={'query':{'search':[]},'nobelPrizes':[]})
    out=w.search('2026年诺奖得主',client_factory=factory(handler))
    assert out['status']=='empty' and out['sources']==[] and out['answer'] is None

@pytest.mark.parametrize('url',[
    'http://example.org/a','https://localhost/a','https://127.0.0.1/a',
    'https://[::1]/a','https://10.0.0.1','https://172.16.0.1','https://192.168.1.1',
    'https://169.254.169.254/latest','https://168.63.129.16','https://[ff02::1]',
    'https://[::ffff:127.0.0.1]','https://foo.local','https://foo.internal',
    'https://example.org:444/a','https://user:pass@example.org/a',
    'https://example.org\\@127.0.0.1/','https://example.org/\n'
])
def test_unsafe_page_url_never_fetched(url):
    assert not w.public_url(url)
    with httpx.Client(transport=httpx.MockTransport(lambda r:pytest.fail('unsafe GET'))) as c:
        with pytest.raises(ValueError):w.fetch_page(url,c)


@pytest.mark.parametrize('addresses', [['127.0.0.1'],['10.1.1.1'],['::1'],
                                      ['93.184.216.34','169.254.169.254']])
def test_dns_private_and_mixed_answers_rejected(monkeypatch,addresses):
    monkeypatch.setattr(w.socket,'getaddrinfo',lambda *a,**kw:[(2,1,6,'',(address,443)) for address in addresses])
    with httpx.Client(transport=httpx.MockTransport(lambda r:pytest.fail('DNS unsafe'))) as c:
        with pytest.raises(ValueError):w.fetch_page('https://example.org/a',c)


def test_dns_rebinding_cannot_change_pinned_tcp_destination(monkeypatch):
    calls=[]
    def resolve(*a,**kw):
        calls.append(a)
        address='93.184.216.34' if len(calls)==1 else '127.0.0.1'
        return [(2,1,6,'',(address,443))]
    monkeypatch.setattr(w.socket,'getaddrinfo',resolve)
    def handler(r):
        assert r.url.host=='93.184.216.34' and r.headers['host']=='example.org'
        assert r.extensions['sni_hostname']=='example.org'
        return httpx.Response(200,headers={'content-type':'text/plain'},text='safe body')
    with httpx.Client(transport=httpx.MockTransport(handler),trust_env=False) as c:
        assert w.fetch_page('https://example.org/a',c)=='safe body'
    assert len(calls)==1


@pytest.mark.parametrize('failure',['redirect','length','stream_size','binary','timeout'])
def test_page_limits_no_redirect_or_error_leak(monkeypatch,failure):
    monkeypatch.setattr(w,'resolve_public',lambda h:'93.184.216.34')
    seen=[]
    def handler(r):
        seen.append(r)
        assert 0<r.extensions['timeout']['read']<=2
        if failure=='redirect':return httpx.Response(302,headers={'location':'https://127.0.0.1/.env','content-type':'text/html'})
        if failure=='length':return httpx.Response(200,headers={'content-length':'256001','content-type':'text/plain'},text='x')
        if failure=='stream_size':return httpx.Response(200,headers={'content-type':'text/plain'},content=b'x'*256001)
        if failure=='binary':return httpx.Response(200,headers={'content-type':'application/octet-stream'},content=b'x')
        raise httpx.ReadTimeout('private-key-never-output')
    with httpx.Client(transport=httpx.MockTransport(handler),trust_env=False) as c:
        with pytest.raises((ValueError,httpx.HTTPStatusError,httpx.TimeoutException)):
            w.fetch_page('https://example.org/a',c)
    assert len(seen)==1


def test_search_returns_in_budget_when_dns_blocks(monkeypatch):
    gate=threading.Event()
    monkeypatch.setattr(w,'duckduckgo_sources',lambda *a:[dict(title='public knowledge',url='https://example.org/a',snippet='public knowledge')])
    monkeypatch.setattr(w,'bing_sources',lambda *a:[])
    monkeypatch.setattr(w,'wikipedia_sources',lambda *a:[])
    def dns(*a):gate.wait(1);raise ValueError('no DNS')
    monkeypatch.setattr(w,'resolve_public',dns)
    before=time.monotonic()
    try:
        result=w.search('public knowledge',seconds=.08,client_factory=factory(lambda r:pytest.fail('no GET')))
        assert time.monotonic()-before<.2 and result['sources']
    finally:gate.set()


def test_native_wire_function_call_and_tool_response_roundtrip(monkeypatch):
    from src.agent import agent_provider,provider as p
    real_client=httpx.Client;requests=[]
    # 3d4e37a uses the production native HTTP transport; MockTransport still
    # needs a valid absolute endpoint, without real credentials or a network.
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1')
    monkeypatch.setenv('LLM_MODEL','test-model')
    monkeypatch.setattr(p,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(agent_provider,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(agent_provider,'read_key',lambda:('mock-test-key','test'))
    monkeypatch.setattr(w,'search',lambda *a,**kw:{'status':'empty','sources':[]})
    def handler(request):
        body=json.loads(request.content);requests.append(body)
        assert body['tool_choice']=='auto' and body['stream'] is True
        assert body['tools'][0]['function']['name']=='web_search'
        if len(requests)==1:
            delta={'tool_calls':[{'index':0,'id':'mock-call','type':'function',
                   'function':{'name':'web_search','arguments':json.dumps({'query':'2026年诺奖得主'})}}]}
            finish='tool_calls'
        else:
            tool=body['messages'][-1]
            assert tool['role']=='tool'
            assert tool['tool_call_id']==body['messages'][-2]['tool_calls'][0]['id']
            delta={'content':'2026年诺奖尚未公布。'};finish='stop'
        wire={'choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
        return httpx.Response(200,text='data: '+json.dumps(wire)+'\n\ndata: [DONE]\n\n')
    monkeypatch.setattr(agent_provider.httpx,'Client',lambda **kw:real_client(transport=httpx.MockTransport(handler),**kw))
    out=consume(g.events('2026年诺奖得主 联网查询',p.OpenAICompatibleProvider()))
    assert len(requests)==2 and out['answer']==g.NO_PUBLIC_EVIDENCE
    assert not out['known']


def test_real_today_not_overridden_by_interface_query_date(monkeypatch):
    monkeypatch.setattr(g,'current_date',lambda:'2026-10-13')
    model=Native([{'content':'你好。'}])
    consume(g.events('你好',model,display_date='2017-10-23'))
    prompt=model.requests[0][0][0]['content']
    assert 'Today (current host date): 2026-10-13' in prompt
    assert 'Interface query date (not today): 2017-10-23' in prompt


def test_city_weather_is_model_called_not_weather_keyword_prefetch(monkeypatch):
    from src.agent import city_weather
    calls=[]
    monkeypatch.setattr(city_weather,'query',lambda q,**kw:calls.append(q) or {
        'status':'ok','answer':'上海当前气温22°C。','sources':[
            dict(title='上海天气',url='https://api.open-meteo.com/v1/forecast',snippet='22°C')]})
    model=Native([{'calls':[{'name':'city_weather','arguments':json.dumps({'city':'上海'})}]},
                  {'content':'上海当前气温22°C。'}])
    out=consume(g.events('上海气温多少',model,weather_first=True))
    assert calls==['上海天气'] and out['known']
    assert out['tool_trace'][0]['tool']=='city_weather'


def test_result_url_private_literals_filtered():
    parser=w.SearchHTML()
    parser.feed('<a class="result__a" href="https://127.0.0.1/a">private</a>')
    result=w.merge_sources('private',[('duckduckgo',{'sources':parser.results})])
    assert result==[]
