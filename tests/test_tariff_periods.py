import threading
import time
import pytest
from src.agent import building_tools, chat_engine, chat_topic_hook as hook
from src.agent.tariff_periods import comparison
from src.data.replay_payload import load_replay


@pytest.mark.parametrize('q', ['今天下午哪个时段电费最贵？为什么？', '什么时候电费最便宜', '电价什么时候最高', '查看每小时的电价负荷和储能动作'])
def test_period_route_not_cumulative(q):
    assert building_tools.fast_choices(q) == [{'tool': 'tariff_periods', 'parameters': {}}]


def test_cumulative_and_hvac_routes_unchanged():
    assert building_tools.fast_choices('今天电费多少')[0]['tool'] == 'energy_totals'
    assert not building_tools.fast_choices('空调改24度电费多少')


@pytest.mark.parametrize('scenario', ['normal', 'peak', 'abstain'])
def test_hourly_data_cost_basis_and_labels(scenario):
    d=load_replay(scenario); row=d['hours'][14]
    r=building_tools.execute_choice({'tool':'tariff_periods'}, '今天下午哪个时段电费最贵？为什么？', d, row, '2026-10-13', '14:00')
    e=r['tool_trace'][0]['result']; ops,_=building_tools.load(scenario)
    assert len(e['hours']) == 6 and [h['hour'] for h in e['hours']] == list(range(12,18))
    for h in e['hours']:
        actual=ops['hours'][h['hour']]
        assert h['period_name']=='峰时' and h['price_cny_per_kwh']==1.2
        assert h['building_load_kw']==actual['actual_kw'] and h['grid_kw']==actual['grid_kw']
        assert h['storage_action_name'] in ('充电','放电','不充不放')
    assert '12:00–18:00 都是峰时电价 1.20 元/kWh' in r['answer'] and '电费最高' in r['answer'] and '不是' in r['answer']
    assert '分/kWh' not in r['answer'] and '1.20 元/kWh' in r['answer']
    assert all(not h['completed'] for h in e['hours'] if h['hour']>=14)


def test_distinct_price_and_cost_minima_and_no_false_net_billing():
    d=load_replay('normal');r=building_tools.execute_choice({'tool':'tariff_periods'}, '什么时候最便宜，逐时电价',d,d['hours'][14],'2026-10-13','14:00')
    e=r['tool_trace'][0]['result']
    assert e['lowest_price_hours']==list(range(7)) and len(e['hours'])==24
    assert '不计入截至当前的累计电费' in r['answer'] and '结算账单' in r['answer']


def test_known_period_question_never_asks_model_for_unsupported_explanation(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class NoModel:
        def chat_stream(self,*a): pytest.fail('period explanation comes from explicit cost basis')
        def chat_call(self,*a): pytest.fail('known tool bypasses selection')
    d=load_replay('normal');g=chat_engine.events('今天下午哪个时段电费最贵？为什么？',d,d['hours'][14],NoModel(),'2026-10-13','14:00')
    events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:r=end.value;break
    assert r['known'] and events[-1]['explanation_source']=='template'
    assert [e['tool'] for e in events if e['type']=='tool_start']==['tariff_periods']
    assert next(e['name'] for e in events if e['type']=='tool_start')=='分时电价与用电'
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==r['answer']
    detail=chat_engine.events('逐时电价负荷',d,d['hours'][14],NoModel(),'2026-10-13','14:00')
    delta=[]
    while True:
        try:
            e=next(detail)
            if e['type']=='answer_delta':delta.append(e['text'])
        except StopIteration as end:full=end.value;break
    assert ''.join(delta)==full['answer']
    assert '1,143.3 kW' in full['answer'] and '.0.0' not in ''.join(delta)
    assert '0.35 元/kWh' in ''.join(delta) and '1.20 元/kWh' in ''.join(delta)


def test_classification_and_tool_overlap_but_answer_waits(monkeypatch):
    classified=threading.Event();tool=threading.Event()
    monkeypatch.setattr(hook.topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**kw):
        assert tool.wait(1), 'serial classify-before-tool deadlock'
        time.sleep(.05);classified.set()
        return {'category':'none','reason':'safe'}
    monkeypatch.setattr(hook.topic_guard,'classify_topic',classify)
    def pipeline():
        yield {'type':'tool_start','tool':'tariff_periods'}
        tool.set()
        yield {'type':'tool_end','tool':'tariff_periods'}
        yield {'type':'answer_delta','text':'已查到。'}
        yield {'type':'done','known':True}
    events=hook.guarded_events('时段电费',[],'parallel',pipeline,object())
    assert next(events)['type']=='tool_start' and not classified.is_set()
    remaining=list(events)
    assert classified.is_set() and remaining[-1]['classification_timing']['answer_gate_wait_ms']>=40
    assert remaining[-1]['classification_timing']['pipeline_ms']<40


def test_first_token_budget_is_twelve():
    from src.agent.chat_sentence_stream import FIRST_TOKEN_SECONDS
    assert FIRST_TOKEN_SECONDS==12
