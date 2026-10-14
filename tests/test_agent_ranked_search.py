import copy,json,threading
import pytest
from src.agent.agent_relevance import filter_result
from src.agent.agent_tools import run_tool
from tests.test_agent_v3 import fixture,Fake,call
from src.agent import agent_runner as runner
from src.agent.chat_engine import consume


@pytest.fixture(autouse=True)
def no_official_network(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'lookup', lambda *a, **k: None)


def official_sources():
    return [{'title':'2026 年'+category+'奖','snippet':'官方获奖者摘要，不含诺奖关键词','body':'Official full text '+str(i),'url':f'https://www.nobelprize.org/2026/{i}'} for i,category in enumerate(['化学','经济学','文学','和平','物理学'])]


@pytest.mark.parametrize('question',['2026年诺奖得主','2026年杭州马拉松男子冠军是谁'])
def test_generic_search_no_keyword_pruning_no_mutation(question,monkeypatch):
    sources=official_sources();original={'status':'ok','sources':sources,'answer':'原搜索结果','metadata':{'ranked':True}}
    saved=copy.deepcopy(original);assert filter_result(question,original)==saved
    from src.agent import web_search
    monkeypatch.setattr(web_search,'search',lambda *a,**k:copy.deepcopy(original))
    d,r=fixture();out=run_tool('web_search',{'query':question},d,r,'2026-10-13','19:30',2,threading.Event(),question)
    assert out['success'] and out['data']==saved and out['trace'][0]['result']==saved
    assert original==saved


def test_weather_and_news_keep_at_least_ranked_top_three_even_without_keyword_match():
    result={'status':'ok','sources':official_sources(),'answer':'未修改答复'}
    for q in ('北京天气新闻','杭州最近天气','最新体育新闻'):
        out=filter_result(q,result)
        assert out['sources']==result['sources'] and out['sources'][:3]==result['sources'][:3]
        assert out['answer']==result['answer']
    assert filter_result('北京天气新闻',{'status':'empty','sources':[]})['answer']=='没查到相关报道。'


def test_native_loop_model_receives_original_titles_snippets_and_bodies(monkeypatch):
    from src.agent import web_search
    raw={'status':'ok','sources':official_sources(),'answer':'官方结果'}
    monkeypatch.setattr(web_search,'search',lambda *a,**k:raw)
    d,r=fixture();p=Fake([{'calls':[call('more_tools',category='internet')]},{'calls':[call('web_search',query='2026年诺奖得主')]},{'content':'已取得官方候选资料，需逐项核对得主。'}])
    out=consume(runner.events('2026年诺奖得主',d,r,p,'2026-10-13','19:30'))
    payload=json.loads(next(m['content'] for m in reversed(p.requests[2][0]) if m['role']=='tool'))
    assert payload['data']['sources']==raw['sources']
    assert payload['data']['answer']=='官方结果' and '没查到' not in out['answer']
