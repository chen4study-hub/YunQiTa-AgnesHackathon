import threading
import pytest
from src.agent.agent_validation import validate_answer
from src.agent.agent_tools import run_tool
from src.agent.chat_engine import consume
from src.agent.chat_display import reading_text
from src.agent.answer_scope import compact_day_words
from src.agent.chat_sentence_stream import exclusion_present
from tests.test_agent_v3 import fixture, Fake


def record(name,q,**args):
    d,r=fixture()
    return run_tool(name,args,d,r,'2026-10-13','14:00',2,threading.Event(),q)


def test_daily_binding_not_list_position():
    rec=record('energy_totals','最近3天用电情况',days=3)
    wrong='前一天用电21,852.0 kWh，电费18,565.3 元。前前一天用电23,977.9 kWh，电费21,092.5 元。'
    assert any(i.get('reason')=='daily_date_value_mismatch' for i in validate_answer(wrong,[rec],'最近3天用电情况')[1])
    correct='前前一天用电21,852.0 kWh，电费18,565.3 元。前一天用电23,977.9 kWh，电费21,092.5 元。'
    assert not validate_answer(correct,[rec],'最近3天用电情况')[1]


def test_counts_clocks_urls():
    text='人数3869人，次日 01:00、次日 02:00、次日 03:00。https://x.test/3869?date=2026-10-13'
    out=reading_text(text)
    assert '3,869 人' in out and out.count('次日')==1 and '01:00' in out
    assert out.endswith('https://x.test/3869?date=2026-10-13')


def test_day_exclusions_inherit_qualifier():
    rec=record('hvac_compare','空调改到24度',setpoint_c=24)
    assert all(exclusion_present(reading_text(rec['reference']),e) for e in rec['trace'][-1]['result']['excluded'])
    for s in reading_text(rec['reference']).split('。'):
        assert s.count('今天')+s.count('次日')<=2


def test_next_day_peak_required():
    rec=record('forecast_peak','明天最高负荷',scope='next_day')
    peak=rec['trace'][-1]['result']
    assert any(i.get('reason')=='next_day_peak_label_required' for i in validate_answer(f"峰值{peak['peak_kw']} kW，13:00。",[rec],'明天最高负荷')[1])
    assert not validate_answer(rec['reference'],[rec],'明天最高负荷')[1]


def test_two_sentences_and_typhoon_grounding():
    assert any(i.get('reason')=='exactly_two_sentences_required' for i in validate_answer('好。好。好。',[],'陪我聊两句')[1])
    assert not validate_answer('好。好。',[],'陪我聊两句')[1]
    assert any(i.get('reason')=='typhoon_impact_not_supported' for i in validate_answer('上海晴，当前没有明显台风影响。',[],'上海有没有台风影响')[1])
    assert not validate_answer('现有工具数据没有可核实台风影响的依据，不能据天气读数判断有无台风影响。',[],'上海有没有台风影响')[1]


@pytest.mark.parametrize('switch',['0','1'])
def test_demo_templates_or_reject_never_timeout(monkeypatch,switch):
    monkeypatch.setenv('LLM_MODE','demo');monkeypatch.setenv('CHAT_AGENT_LOOP',switch)
    from src.agent.chat_router import route_events
    from src.agent.agent_runner import events
    from src.agent.provider import OpenAICompatibleProvider
    from src.agent.agent_provider import AgentProvider
    def forbidden(*a,**kw):raise AssertionError('offline must not request upstream')
    monkeypatch.setattr(OpenAICompatibleProvider,'chat_stream',forbidden)
    monkeypatch.setattr(AgentProvider,'agent_stream',forbidden)
    d,r=fixture();fn=events if switch=='1' else route_events
    result=consume(fn('帮我写一首诗',d,r,display_date='2026-10-13',display_time='14:00'))
    assert result['reason']=='out_of_scope' and result['answer']=='这个问题超出了看板能回答的范围。'
    assert not result['llm_called'] and '超时' not in result['answer']
    result=consume(fn('当前楼宇总用电功率',d,r,display_date='2026-10-13',display_time='14:00'))
    assert result['known'] and 'kW' in result['answer'] and not result['llm_called']


def test_public_concepts_not_local_readings():
    assert not validate_answer('SOC通常在0%到100%之间。',[],'SOC是什么意思')[1]
    assert validate_answer('本楼储能现在50%。',[],'本楼储能现在多少')[1]


def test_raw_storage_dates_ids_and_science_not_rounded_prose():
    from src.agent.answer_grounding import numeric_issues
    rec=record('storage_history','今天储能充电量')
    assert not numeric_issues(rec['reference'],[rec])
    assert numeric_issues('充电99999 kWh。',[rec])
    rec=record('energy_totals','前天用电',relative_day=-2)
    assert not numeric_issues(rec['reference'],[rec])
    assert numeric_issues('10 月 1 日用电21,852.0 kWh。',[rec])
    rec=record('building_state','运行概览')
    assert not numeric_issues(rec['reference'],[rec])
