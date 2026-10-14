from email.utils import format_datetime
from datetime import datetime,timedelta,timezone
import httpx,pytest,time
from src.agent import web_search as w
from src.agent import city_weather

@pytest.mark.parametrize('q,city',[('上海明天天气如何','上海'),('今天北京的天气新闻有哪些？给出来源链接','北京'),('伦敦现在气温多少？','伦敦')])
def test_city_extraction(q,city):assert city_weather.city_name(q)==city

def test_open_meteo_fixed_endpoints_current_and_tomorrow():
    seen=[]
    def handler(r):
        seen.append(r.url)
        if r.url.host=='geocoding-api.open-meteo.com':return httpx.Response(200,json={'results':[{'name':'上海','latitude':31.2,'longitude':121.4}]})
        return httpx.Response(200,json={'current':{'time':'2026-10-12T14:00','temperature_2m':22.,'precipitation':0.,'weather_code':1},'daily':{'time':['2026-10-12','2026-10-13'],'temperature_2m_min':[19.,20.],'temperature_2m_max':[24.,25.],'precipitation_sum':[0.,2.],'weather_code':[1,3]}})
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:r=city_weather.lookup('上海明天天气如何',c)
    assert r['status']=='ok' and '次日最低 20.0 °C' in r['answer']
    assert len(seen)==2 and all(u.scheme=='https' for u in seen)

def test_single_relevant_bing_result_is_usable():
    xml='<rss><channel><item><title>北京天气</title><link>https://example.org/a</link><description>天气消息</description></item><item><title>无关内容</title><link>https://example.org/b</link></item></channel></rss>'
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,text=xml))) as c:
        assert [s['url'] for s in w.bing_sources('北京 天气',c)]==['https://example.org/a']


def test_bing_news_wrapper_decoded_locally_never_followed():
    stamp=format_datetime(datetime.now(timezone.utc)-timedelta(hours=1))
    urls=[]
    xml='<rss><channel><item><title>北京天气报道</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fexample.org%2Fnews</link><description>北京天气</description><pubDate>'+stamp+'</pubDate></item></channel></rss>'
    def handler(r):urls.append(r.url);return httpx.Response(200,text=xml)
    with httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=False) as c:
        sources=w.bing_sources('今天北京天气新闻给出来源链接',c,news=True)
    assert len(urls)==1 and urls[0].path=='/news/search'
    assert sources[0]['url']=='https://example.org/news' and '发布时间' in sources[0]['snippet']


def test_generic_weather_query_uses_same_parallel_sources(monkeypatch):
    seen=[]
    monkeypatch.setattr(w,'duckduckgo_sources',lambda q,c:seen.append('ddg') or [
        dict(title='北京天气新闻',url='https://example.org/weather',snippet='北京天气报道')])
    monkeypatch.setattr(w,'bing_sources',lambda q,c:seen.append('bing') or [])
    monkeypatch.setattr(w,'wikipedia_sources',lambda q,c:seen.append('wiki') or [])
    monkeypatch.setattr(w,'fetch_page',lambda *a:'北京天气报道')
    r=w.search('北京天气新闻',client_factory=lambda **kw:httpx.Client(transport=httpx.MockTransport(lambda r:pytest.fail('sources mocked')),**kw))
    assert set(seen)=={'ddg','bing','wiki'} and r['sources']
    assert not r.get('city_weather') and not r.get('recent_news')


def test_city_weather_fixed_adapter_success_no_generic_search(monkeypatch):
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('no generic search for city adapter'))
    def handler(r):
        if r.url.host=='geocoding-api.open-meteo.com':return httpx.Response(200,json={'results':[{'name':'上海','latitude':31.2,'longitude':121.4}]})
        return httpx.Response(200,json={'current':{'time':'2026-10-13T14:00','temperature_2m':22.,'precipitation':0.,'weather_code':1},'daily':{'time':['2026-10-13','2026-10-14'],'temperature_2m_min':[19.,20.],'temperature_2m_max':[24.,25.],'precipitation_sum':[0.,2.],'weather_code':[1,3]}})
    result=city_weather.query('上海天气',client_factory=lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw))
    assert result['city_weather']['city']=='上海' and result['sources']


def test_city_request_whole_lookup_deadline_not_two_timeouts():
    import threading
    cancel=threading.Event()
    def handler(r):
        time.sleep(.04)
        if r.url.host=='geocoding-api.open-meteo.com':return httpx.Response(200,json={'results':[{'name':'上海','latitude':31.2,'longitude':121.4}]})
        time.sleep(.2);return httpx.Response(200,json={})
    start=time.monotonic()
    result=city_weather.query('上海明天天气如何',seconds=.08,cancel=cancel,client_factory=lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw))
    assert time.monotonic()-start<.15 and not result['sources'] and not cancel.is_set()
    time.sleep(.25) # admission slot waits for real worker termination


def test_london_requires_gb_not_canadian_namesake():
    seen=[]
    def handler(r):
        seen.append(r.url)
        return httpx.Response(200,json={'results':[{'name':'伦敦','country_code':'CA','latitude':42.9,'longitude':-81.2}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(ValueError,match='ambiguous'):city_weather.lookup('伦敦现在气温多少？',c)
    assert len(seen)==1 and seen[0].params['countryCode']=='GB'
