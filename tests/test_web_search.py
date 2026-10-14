from email.utils import format_datetime
from datetime import datetime,timedelta,timezone
import json
from datetime import date
import httpx
import pytest
from src.agent import web_search as w
from src.agent.chat import answer
from src.data.replay_payload import load_replay


def test_official_nobel_answer_and_empty_future():
    def handler(r):
        y=r.url.params['nobelPrizeYear']
        return httpx.Response(200,json={'nobelPrizes':[] if y=='2099' else [{'awardYear':y,'dateAwarded':'2020-10-07','category':{'en':'Chemistry'},'laureates':[{'knownName':{'en':'A'}}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        a=w.lookup('2020年诺贝尔奖得主',c);assert a['status']=='ok' and 'A' in a['answer'] and w.safe_url(a['sources'][0]['url'])
        a=w.lookup('2099年诺贝尔奖得主',c);assert a['status']=='empty' and not a['sources']


def test_fetch_timeout_unavailable_and_no_leaked_errors():
    def handler(r):raise httpx.ReadTimeout('private-not-for-output')
    a=w.search('公开信息',seconds=.2,client_factory=lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw))
    assert a['status']=='unavailable' and 'private' not in str(a)


def test_no_arbitrary_url_fetch_and_redirect():
    for url in ['http://127.0.0.1','https://127.0.0.1','https://zh.wikipedia.org@evil.test','https://zh.wikipedia.org:443/a']:
        assert not w.safe_url(url)
    def handler(r):return httpx.Response(302,headers={'Location':'http://127.0.0.1/.env'})
    with httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=False) as c:
        with pytest.raises(httpx.HTTPStatusError):w.get(c,'https://api.nobelprize.org/2.1/nobelPrizes')


def test_nobel_public_path_native_search_and_links_preserved(monkeypatch):
    from tests.test_public_native_search import Native,call
    from src.agent.chat_engine import consume
    from src.agent.general_chat import events,NO_PUBLIC_EVIDENCE
    monkeypatch.setattr(w,'search',lambda q,**kw:{'status':'unavailable','sources':[]})
    a=consume(events('2026年诺奖得主 联网查询',Native([call('2026年诺奖得主'),{'content':'2026年诺奖尚未公布。'}])))
    assert a['reason']=='answered' and not a['needs_human'] and a['answer']==NO_PUBLIC_EVIDENCE
    url='https://api.nobelprize.org/2.1/nobelPrizes?nobelPrizeYear=2026'
    monkeypatch.setattr(w,'search',lambda q,**kw:{'status':'ok','sources':[{'title':'2026 Nobel','url':url}],'answer':'已公布名单。'})
    a=consume(events('2026年诺奖得主',Native([call('2026年诺奖得主'),{'content':'已公布名单。'}])))
    assert url in a['answer'] and a['known'] and a['reason']=='answered'


def test_building_question_never_leaks_to_public_search(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');r=d['hours'][14]
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('must stay building evidence'))
    for q in ['这个楼业主是谁','现在空调用电占多少','今天用了多少电']:
        a=answer(q,d,r,display_date='2026-10-12',display_time='14:00')
        assert a['reason'] in ('answered','no_data') and all(t['tool']!='web_search' for t in a['tool_trace'])


def test_unpublished_award_date_is_not_reported():
    future=(date.today().replace(year=date.today().year+1)).isoformat()
    def handler(r):return httpx.Response(200,json={'nobelPrizes':[{'awardYear':'2026','dateAwarded':future,'category':{'en':'Peace'},'laureates':[{'knownName':{'en':'Future Person'}}]}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        a=w.lookup('2026年诺贝尔奖',c);assert a['status']=='empty' and not a['sources']


def test_bing_rss_relevant_sources_deduplicated_and_no_redirects():
    stamp=format_datetime(datetime.now(timezone.utc)-timedelta(hours=1))
    xml='<rss><channel><item><title>Building maintenance</title><link>https://example.org/guide</link><description>Maintenance knowledge</description><pubDate>'+stamp+'</pubDate></item><item><title>Building maintenance</title><link>https://example.org/guide</link><description>More</description><pubDate>'+stamp+'</pubDate></item><item><title>Baseball</title><link>https://example.org/baseball</link><description>Game</description></item></channel></rss>'
    seen=[]
    def handler(r):
        seen.append(r.url)
        return httpx.Response(200,text=xml)
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        sources=w.bing_sources('search building maintenance',c,news=True)
    assert len(sources)==1 and sources[0]['url']=='https://example.org/guide'
    assert len(seen)==1 and seen[0].host=='www.bing.com'


def test_search_timeout_does_not_cancel_llm_in_same_request():
    import threading,time
    external=threading.Event()
    def handler(r):time.sleep(.1);raise httpx.ReadTimeout('not public')
    out=w.search('public query',seconds=.02,cancel=external,client_factory=lambda **kw:httpx.Client(transport=httpx.MockTransport(handler),**kw))
    assert out['status']=='unavailable' and not external.is_set()


def test_nobel_specific_category_title_and_entry_are_real_not_first_general_item():
    prizes=[{'awardYear':'2024','dateAwarded':'2024-10-09','category':{'en':'Chemistry'},'laureates':[{'knownName':{'en':'Chemistry Person'}}]},
      {'awardYear':'2024','dateAwarded':'2024-10-08','category':{'en':'Physics'},'laureates':[{'knownName':{'en':'John Hopfield'}},{'knownName':{'en':'Geoffrey Hinton'}}],
       'links':[{'rel':'nobelPrize','href':'https://api.nobelprize.org/2/nobelPrize/phy/2024'}]}]
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'nobelPrizes':prizes}))) as c:
        result=w.lookup('2024 年物理学奖得主是谁？给出来源链接',c)
    assert len(result['sources'])==1
    assert result['sources'][0]['title']=='2024 年物理学奖'
    assert result['sources'][0]['url'].endswith('/phy/2024')
    assert 'John Hopfield' in result['answer'] and 'Chemistry Person' not in result['answer']
    # Missing physics is not labelled from a chemistry entry or user wording.
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'nobelPrizes':prizes[:1]}))) as c:
        empty=w.lookup('2024年物理学奖',c)
    assert empty['status']=='empty' and not empty['sources']


def test_nobel_no_specific_link_uses_generic_truthful_title():
    p={'awardYear':'2024','dateAwarded':'2024-10-08','category':{'en':'Physics'},'laureates':[{'knownName':{'en':'Actual Name'}}]}
    with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'nobelPrizes':[p]}))) as c:
        result=w.lookup('2024年物理学奖',c)
    assert result['sources'][0]['title']=='诺贝尔奖官方查询资料'
    assert 'nobelPrizeCategory=phy' in result['sources'][0]['url']
