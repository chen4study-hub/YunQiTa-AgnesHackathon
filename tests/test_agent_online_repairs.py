"""Deployment hotfix: tool-backed fallback and cumulative storage ellipsis."""
import threading
import pytest
from tests.test_agent_v3 import Fake, fixture, call
from src.agent import agent_runner as runner
from src.agent.agent_tools import run_tool
from src.agent.agent_validation import validate_answer
from src.agent.agent_prefetch import plan
from src.agent.storage_scope import resolve_followup
from src.agent.chat_engine import consume


class Failed(Fake):
    def agent_stream(self, messages, catalogue, seconds, first_seconds):
        self.requests.append((messages, catalogue, seconds, first_seconds))
        yield {'kind':'failure','reason':'first_token_timeout'}


def test_tariff_reference_all_clocks_supported():
    d,r=fixture()
    for q in ('下午哪个时段电费最贵，为什么？','晚上哪个时段电费最贵','现在电价多少'):
        record=run_tool('tariff_periods',{},d,r,'2026-10-13','19:30',2,threading.Event(),q)
        good,issues=validate_answer(record['reference'],[record],q)
        assert not issues and good and runner.template_records([record],q)
    assert validate_answer('电费最高时段是11:31。',[record],q)[1]


@pytest.mark.parametrize('q',[
    '下午哪个时段电费最贵，为什么？','今天储能一共充了多少电？',
    '今天储能累计放电量是多少？','27层CO₂是多少','L1电梯在哪层',
    '今天用了多少电','现在的总负荷是多少','插座用电占比是多少',
    '光伏发了多少电','告警记录','未来24小时最高负荷','现在天气怎么样',
    '储能SOC多少','现在储能功率多少','执行回执是什么'])
def test_all_local_reference_fallback_survives_provider_failure(q):
    d,r=fixture();p=Failed([])
    out=consume(runner.events(q,d,r,p,'2026-10-13','19:30'))
    assert out['known'] and out['reason']=='answered' and out['mode']=='fallback'
    assert '未能取得可用' not in out['answer'] and len(p.requests)==1
    assert out['tool_trace']


def test_valid_tool_sentence_not_lost_with_invalid_other_sentence():
    d,r=fixture();rec=run_tool('building_state',{},d,r,'2026-10-13','19:30',2,threading.Event(),'总负荷')
    rec['reference'] += '另一个负荷987654321 kW。'
    text=runner.template_records([rec],'总负荷')
    assert '当前楼宇总负荷' in text and '987654321' not in text


def test_followup_uses_fresh_today_history_only_and_narrow_answer():
    d,r=fixture();p=Failed([])
    first=consume(runner.events('今天储能一共充了多少电？',d,r,p,'2026-10-13','19:30',session_id='s'))
    assert '802.4 kWh' in first['answer'] and '放电' not in first['answer']
    history=[{'role':'user','content':'今天储能一共充了多少电？'},{'role':'assistant','content':first['answer']}]
    p=Failed([])
    second=consume(runner.events('那放电呢？',d,r,p,'2026-10-13','19:30',history=history,session_id='s',context_id=first['context_id']))
    assert second['answer']=='今天截至 19:30，放电 1,171.7 kWh。'
    assert [t['tool'] for t in second['tool_trace']]==['storage_history']
    assert len(p.requests)==1
    assert plan(resolve_followup('那放电呢？',history))[0][0]['name']=='storage_history'
    assert resolve_followup('那放电呢？',[{'role':'user','content':'今天天气如何'}])=='那放电呢？'
    assert resolve_followup('现在放电功率呢？',history)=='现在放电功率呢？'
    assert resolve_followup('那放电呢？',[{'role':'user','content':'昨天储能充电多少'}])=='那放电呢？'
    assert resolve_followup('那充电呢？',history+[{'role':'user','content':'那放电呢？'}])=='今天储能累计充电量是多少？'


def test_750_vs_1171_is_completed_hour_scope_not_number_change():
    d,r=fixture()
    for clock,discharge in [('14:00',750.0),('19:00',1171.7),('19:30',1171.7)]:
        rec=run_tool('storage_history',{},d,r,'2026-10-13',clock,2,threading.Event(),'今天累计放电量')
        raw=rec['trace'][0]['result']
        assert raw['charge_kwh']==802.4 and raw['discharge_kwh']==discharge
        assert all(h['offset_ms']+3600000<=int(clock[:2])*3600000+int(clock[3:])*60000 for h in raw['records'])


def test_unasked_clock_and_soc_do_not_pollute_timeout_answer():
    d,r=fixture();p=Fake([{'calls':[call('get_time'),call('current_state')]},{'content':'我先查一下。'}])
    out=consume(runner.events('今天储能累计放电量是多少？',d,r,p,'2026-10-13','19:30'))
    assert out['answer']=='今天截至 19:30，放电 1,171.7 kWh。'
