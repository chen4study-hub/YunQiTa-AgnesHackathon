import json, threading
import pytest
from tests.test_agent_v3 import fixture, Fake
from tests.test_agent_online_repairs import Failed
from src.agent.chat_engine import consume
from src.agent import agent_runner as runner
from src.agent.agent_tools import run_tool
from src.agent.chat_sentence_stream import exclusion_present
from experiments.agent_v3_20261013.semantic_assertions import check, no_local_identity
from experiments.agent_v3_20261013 import probe


def test_interval_day_inherits_but_not_across_full_stop_or_wrong_reason():
    e={'day_label':'次日','hour':14,'minute':0,'reason':'预测变化较大'}
    assert exclusion_present('次日 08:00–09:00、13:00–19:00（预测变化较大）。',e)
    assert not exclusion_present('今天 13:00–19:00（预测变化较大）。',e)
    assert not exclusion_present('次日 08:00–09:00。13:00–19:00（预测变化较大）。',e)
    assert not exclusion_present('次日 13:00–19:00（设备检修）。今天预测变化较大。',e)


@pytest.mark.parametrize('text',['本楼业主系统里没有。','业主和物业记录里没有公开信息，这里查不到。','物业信息这边没有相关记录，查不到。','没有查到本楼物业信息。'])
def test_identity_synonyms_and_base_evaluate_same(text):
    assert no_local_identity(text)
    assert check({'question':'本楼业主是谁','semantic_check':'no_local_identity'},text,[])
    assert probe.evaluate({'question':'本楼业主是谁','allow_no_data':True},text,[],{'known':False,'grounded':True},[],1)
    assert not no_local_identity(text+'物业公司是某某公司。')


def test_elevator_only_requested_id_not_unrequested_floorless_moving_lifts():
    d,r=fixture();rec=run_tool('elevator_state',{},d,r,'2026-10-13','14:00',2,threading.Event(),'L1电梯在哪层')
    case={'question':'L1电梯在哪层','tool':'elevator_state','semantic_check':'lift_field','expected_field':'floor','expected_unit':'层'}
    assert check(case,'L1 停靠20层。',[rec]) and check(case,rec['reference'],[rec])
    assert not check(case,'L1 停靠2层，L3停靠20层。',[rec])
    assert not check(case,'L3 停靠20层。',[rec])


def test_real_trace_satisfies_tool_even_without_event_but_missing_trace_does_not():
    c={'question':'当前总负荷','tool':'building_state','contains':['1,258.1 kW']};a='当前总负荷1,258.1 kW。';done={'known':True,'grounded':True}
    assert probe.evaluate(c,a,[],done,[],1,[{'tool':'building_state','result':{'actual_kw':1258.1}}])
    assert not probe.evaluate(c,a,[],done,[],1,[])


def test_prefetched_result_caps_first_decision_and_does_not_retry():
    d,r=fixture();p=Failed([])
    out=consume(runner.events('今天储能累计放电量',d,r,p,'2026-10-13','14:00'))
    assert len(p.requests)==1 and p.requests[0][2]<=10 and out['known']


@pytest.mark.parametrize('first,follow,expected',[
    ('电池SOC是多少','刚才电池电量是多少？只说这个读数。','储能电量 36.4%。'),
    ('现在是什么天气','那湿度呢？','当前室外湿度 57.0%。'),
    ('当前能源怎么样','刚才光伏的功率再说一遍','光伏功率 114.3 kW。'),
    ('未来24小时峰值什么时候','刚才的峰值时间再说一遍','次日 13:00。')])
def test_trusted_followup_no_provider_reads_or_assistant_numbers(first,follow,expected):
    d,r=fixture();o=consume(runner.events(first,d,r,Failed([]),'2026-10-13','14:00',session_id='s'))
    p=Failed([]);out=consume(runner.events(follow,d,r,p,'2026-10-13','14:00',session_id='s',context_id=o['context_id'],history=[{'role':'user','content':first},{'role':'assistant','content':'999999.9'}]))
    assert not p.requests and out['answer']==expected and not out['llm_called']
    p=Failed([]);missing=consume(runner.events(follow,d,r,p,'2026-10-13','15:00',session_id='s',context_id=o['context_id']))
    assert p.requests and missing['llm_reason']!='trusted_followup'


def test_hvac_followup_exclusions_and_relative_request_host_context():
    d,r=fixture();o=consume(runner.events('空调改到24度能省多少钱',d,r,Failed([]),'2026-10-13','14:00',session_id='h'))
    p=Failed([]);out=consume(runner.events('刚才的比较排除了哪些时段？请列出全部时间和原因。',d,r,p,'2026-10-13','14:00',session_id='h',context_id=o['context_id']))
    assert not p.requests and '14:00' in out['answer'] and '次日' in out['answer'] and '元' not in out['answer']
    history=[{'role':'user','content':'空调设定多少'},{'role':'assistant','content':'24.0 °C'}]
    out=consume(runner.events('比刚才的设定调低一度，电费会怎样？',d,r,Failed([]),'2026-10-13','14:00',history=history))
    assert any(t['tool']=='compare_costs' for t in out['tool_trace']) and '24.5 °C' in out['answer']


def test_clock_and_identity_never_call_model():
    d,r=fixture()
    for q,a in [('现在几点','现在 14:00。'),('那今天几号？','今天是 10 月 13 日。'),('本楼业主是谁','本楼业主和物业信息没有相关记录，查不到。')]:
        p=Failed([]);o=consume(runner.events(q,d,r,p,'2026-10-13','14:00'))
        assert not p.requests and o['answer']==a and not o['llm_called']
