import pytest
from src.agent import general_chat,city_weather,web_search,chat_router,chat_engine

ABSENCE = [
    '没有查到关于今天台风对上海天气影响的具体资料。',
    '抱歉，未能找到这次台风登陆时间的可靠信息。',
    '目前暂无关于这场暴雨影响范围的公开报道，请关注气象部门通报。',
    '没有查到关于今天台风对上海天气影响的具体资料。请关注气象部门通报。',
]


@pytest.mark.parametrize('raw',ABSENCE)
@pytest.mark.parametrize('stream',[False,True])
def test_subject_varying_absence_never_gets_knowledge_prefix(monkeypatch,raw,stream):
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:{'status':'empty','sources':[]})
    class Call:
        def chat_call(self,*a):return {'result':{'answer':raw},'llm':{'mode':'real','reason':'call_succeeded'}}
    class Stream:
        def chat_stream(self,*a):
            yield {'type':'text_delta','text':raw}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    g=general_chat.events('搜索具体影响资料',Stream() if stream else Call(),web=True)
    emitted=[]
    while True:
        try:
            e=next(g)
            if e['type']=='answer_delta':emitted.append(e['text'])
        except StopIteration as end:out=end.value;break
    assert '常识整理' not in out['answer'] and '常识整理' not in ''.join(emitted)
    assert out['answer'].startswith(raw.split('。')[0])
    assert out['answer']==''.join(emitted)


def test_absence_with_real_knowledge_keeps_knowledge_label():
    raw='未查到今天具体台风资料。台风通常会带来强风和降雨。'
    assert not general_chat.missing_public_answer(raw)
    assert '常识整理' in general_chat.public_no_source_text(raw)


@pytest.mark.parametrize('q,city',[('今天台风对上海天气有什么影响','上海'),
    ('台风影响深圳的天气吗','深圳'),('上海台风情况怎么样','上海'),('上海明天天气如何','上海'),('伦敦现在气温多少','伦敦')])
def test_city_impact_extraction(q,city):assert city_weather.city_name(q)==city


def test_typhoon_calls_city_weather_before_news_and_cannot_invent_impact(monkeypatch):
    calls=[]
    monkeypatch.setattr(city_weather,'query',lambda q,**kw:calls.append('city_weather') or {
        'status':'ok','city_weather':{'city':'上海'},'answer':'上海当前气温 20.0 °C。',
        'sources':[{'title':'Open-Meteo 上海天气','url':'https://api.open-meteo.com/v1/forecast'}]})
    monkeypatch.setattr(web_search,'search',lambda q,**kw:calls.append('web_search') or {
        'status':'empty','recent_news':True,'sources':[],'answer':'最近两周没有查到相关报道。'})
    class Never:
        def chat_call(self,*a):pytest.fail('no model invents current typhoon facts')
        def chat_stream(self,*a):pytest.fail('no model invents current typhoon facts')
    g=chat_router.route_events('今天台风对上海天气有什么影响',{}, {},Never())
    emitted=[]
    while True:
        try:emitted.append(next(g))
        except StopIteration as end:out=end.value;break
    assert calls==['city_weather','web_search']
    starts=[e['tool'] for e in emitted if e['type']=='tool_start']
    assert starts==['city_weather','web_search']
    assert '上海当前气温' in out['answer'] and '不能证明台风影响' in out['answer']
    assert '常识整理' not in out['answer'] and not out['llm_called']
    assert out['tool_trace'][0]['tool']=='city_weather'


def test_plain_city_weather_actual_tool_first_and_no_model(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setattr(city_weather,'query',lambda *a,**kw:{'status':'empty','sources':[]})
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:pytest.fail('city query adapter mocked; no separate search'))
    g=chat_router.route_events('上海明天天气如何',{}, {})
    events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:out=end.value;break
    assert [e['tool'] for e in events if e['type']=='tool_start']==['city_weather']
    assert out['answer']=='上海的城市天气暂时查不到。'


def test_typhoon_query_keeps_impact_terms():
    query=web_search.search_query('今天台风对上海天气有什么影响新闻')
    assert '台风' in query and '上海' in query and '影响' in query


def test_identity_ends_period():
    assert chat_router.no_local_information()['answer']=='这个信息系统里没有。'
