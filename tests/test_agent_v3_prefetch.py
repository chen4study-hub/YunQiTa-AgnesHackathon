import json
import threading
from src.agent import agent_runner as runner, agent_tools as tools
from src.agent.agent_prefetch import plan
from src.agent.agent_validation import validate_answer, public_prose
from src.agent.agent_relevance import filter_result, relevant
from src.agent.chat_engine import consume
from tests.test_agent_v3 import Fake, fixture


def test_first_model_sees_floor_evidence_and_open_category():
    d,r=fixture();p=Fake([{'content':'27层当前 CO₂ 550.0 ppm。'}])
    result=consume(runner.events('27层CO₂是多少',d,r,p,'2026-10-13','14:00'))
    assert result['mode']=='llm' and len(p.requests)==1
    assert result['tool_trace'][0]['tool']=='floor_state'
    messages,visible,*_=p.requests[0]
    assert any('本轮主机已查询' in m['content'] and '550' in m['content'] for m in messages)
    assert 'floor_state' in {t['function']['name'] for t in visible}


def test_three_read_jobs_really_parallel_and_joined(monkeypatch):
    barrier=threading.Barrier(3);seen=[]
    def run(name,*args):
        seen.append(name);barrier.wait(timeout=2)
        return {'success':True,'trace':[],'reference':'查询完成。','evidence':{},'data':{},'needs_human':False}
    monkeypatch.setattr(runner,'run_tool',run)
    choices,expanded=plan('27层温度多少？今天用了多少电？执行回执是什么？储能SOC多少？')
    assert len(choices)==3 and 'operations' in expanded and 'building' in expanded
    d,r=fixture();records=[];timings=[]
    consume(runner.prefetch(choices,d,r,'2026-10-13','14:00',runner.time.monotonic()+3,
                           threading.Event(),runner.ProgressClock(),records,timings))
    assert len(seen)==3 and len(records)==3
    assert not any(t.name.startswith('agent-prefetch') for t in threading.enumerate())


def test_public_and_concepts_not_prefetched_but_internet_preexpanded():
    for q in ('上海天气怎么样','联网查询5个楼宇运维的基础知识点','北京天气新闻','2024年物理学奖得主是谁'):
        choices,expanded=plan(q);assert not choices and 'internet' in expanded
    assert not plan('介绍一下电梯的工作原理')[0]
    assert not plan('储能电池的SOC是什么意思')[0]


def test_fast_scope_current_total_h1_and_charge():
    assert plan('今天储能充电量')[0][0]['name']=='storage_history'
    assert plan('现在的总负荷是多少')[0][0]['name']=='building_state'
    assert plan('H1电梯载重是多少')[0][0]['args']=={'elevator':'H1'}
    assert plan('插座用电占比')[0][0]['args']['scope']=='current'
    assert plan('现在电价多少')[0][0]['name']=='tariff_periods'
    assert plan('明天负荷预测')[0][0]['args']=={'scope':'next_day'}


def test_model_transition_repair_uses_prefetched_evidence():
    d,r=fixture();p=Fake([{'content':'我先查一下27层CO₂。'},{'content':'27层 CO₂ 550.0 ppm。'}])
    out=consume(runner.events('27层CO₂是多少',d,r,p,'2026-10-13','14:00'))
    assert len(p.requests)==2 and out['mode']=='llm' and '先查' not in out['answer']


def test_internal_alias_unknown_snake_and_urls():
    url='https://example.org/rule_full?current_state=1234'
    text=public_prose('rule_full 使用 current_state，SOC。来源：'+url)
    assert '全额调度' in text and '设备当前状态' in text and url in text
    good,issues=validate_answer('未知xyz_field。',[],'你好')
    assert not good and any(i['reason']=='internal_identifier' for i in issues)
    assert validate_answer('我先展开联网工具，下一步查天气。',[],'天气')[1]
    assert not validate_answer('BA/EMS 下发日志回执。',[],'知识')[1]


def test_news_ranked_candidates_retained_for_model_not_keyword_judged():
    bad={'title':'2026-10-13 北京银行存款利息','snippet':'最新财经报道','url':'https://x.org/北京天气'}
    elsewhere={'title':'上海暴雨预警','snippet':'气象台发布','url':'https://x.org/2'}
    good={'title':'北京气象台发布降温预报','snippet':'冷空气影响气温','url':'https://x.org/3','published_at':'2026-10-13'}
    assert relevant('北京天气新闻',bad) and relevant('北京天气新闻',elsewhere)
    filtered=filter_result('北京天气新闻',{'status':'ok','sources':[bad,good],'answer':'原未过滤的股票资料'})
    assert filtered['sources']==[bad,good] and filtered['answer']=='原未过滤的股票资料'
    empty=filter_result('北京天气新闻',{'status':'ok','sources':[bad]})
    assert empty['sources']==[bad]


def test_adapter_retains_search_sources_even_without_title_overlap(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:{'status':'ok','sources':[
        {'title':'北京银行利息','snippet':'银行业务','url':'https://x.org/1'}]})
    d,r=fixture();record=tools.run_tool('web_search',{'query':'北京银行'},d,r,'2026-10-13','14:00',1,threading.Event(),'北京天气新闻')
    assert len(record['data']['sources'])==1 and record['data']['sources'][0]['title']=='北京银行利息'
