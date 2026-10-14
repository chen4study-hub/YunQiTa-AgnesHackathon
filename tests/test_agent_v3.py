import json
import threading
import time
import pytest
from src.agent import agent_runner as runner, agent_tools as tools
from src.agent.agent_validation import validate_answer
from src.agent.chat_engine import consume
from src.data.replay_payload import load_replay


def fixture():
    d = load_replay('normal')
    return d, d['hours'][14]


class Fake:
    def __init__(self, messages):
        self.responses = iter(messages)
        self.requests = []
        self._chat_cancel = threading.Event()
    def agent_stream(self, messages, catalogue, seconds, first_seconds):
        self.requests.append((messages.copy(), catalogue, seconds, first_seconds))
        yield {'kind': 'first_token'}
        yield {'kind': 'message', 'message': next(self.responses)}


def call(name, **args):
    return {'name': name, 'arguments': json.dumps(args)}


def test_default_off(monkeypatch):
    monkeypatch.delenv('CHAT_AGENT_LOOP', raising=False)
    assert not runner.enabled()
    monkeypatch.setenv('CHAT_AGENT_LOOP', '1')
    assert runner.enabled()
    monkeypatch.setenv('CHAT_AGENT_LOOP', 'false')
    assert not runner.enabled()


def test_catalogue_all_categories_reachable_and_only_seven_initial():
    initial = {t['function']['name'] for t in tools.available_tools()}
    assert initial == set(tools.COMMON) | {'more_tools'}
    all_names = {t['function']['name'] for t in tools.available_tools(tools.CATEGORIES)}
    assert all_names == set(tools.BY_NAME)
    assert len(all_names) == 22


def test_lazy_expansion_next_request_only(monkeypatch):
    # Exercise model-triggered expansion separately from the host pre-expander.
    monkeypatch.setattr(runner, 'prefetch_plan', lambda q: ([], set()))
    p = Fake([{'calls': [call('more_tools', category='alerts')], 'content': ''},
              {'calls': [call('alerts_orders')], 'content': ''},
              {'calls': [], 'content': '已查询告警记录。'}])
    d, r = fixture()
    out = consume(runner.events('告警记录', d, r, p, '2026-10-13', '14:00'))
    assert len(p.requests[0][1]) == 7  # Local readings hide public search.
    assert 'web_search' not in {t['function']['name'] for t in p.requests[0][1]}
    assert 'alerts_orders' in {t['function']['name'] for t in p.requests[1][1]}
    assert 'elevator_state' not in {t['function']['name'] for t in p.requests[1][1]}
    assert out['mode'] == 'llm' and out['tool_trace'][0]['tool'] == 'alerts_orders'


def test_unexpanded_tool_is_not_executed(monkeypatch):
    ran = []
    monkeypatch.setattr(runner, 'run_tool', lambda *a: ran.append(a))
    p = Fake([{'calls': [call('city_weather', city='北京')]}, {'content': '没查到资料。'}])
    d, r = fixture();consume(runner.events('查询', d, r, p))
    assert not ran


def test_current_weather_forces_current_snapshot_even_if_model_scope_wrong():
    d, r = fixture()
    result = tools.run_tool('get_weather', {'scope': 'today_remaining'}, d, r,
                            '2026-10-13', '14:00', 2, threading.Event(), '当前天气如何')
    weather = result['trace'][0]['result']
    assert weather['scope'] == 'current' and len(weather['hours']) == 1
    assert weather['hours'][0]['timestamp'] == r['t']
    assert tools.normalize_call('get_weather', {'scope': 'future_24h'}, '当前天气')[1] == {'scope': 'current'}


def test_soc_current_state_not_storage_history():
    assert tools.normalize_call('storage_history', {}, '电池还剩多少电') == ('current_state', {})
    assert tools.normalize_call('storage_history', {}, '今天累计充放电记录') == ('storage_history', {})
    d, r = fixture()
    result = tools.run_tool('storage_history', {}, d, r, '2026-10-13', '14:00', 2,
                            threading.Event(), '储能SOC多少')
    assert result['trace'][0]['tool'] == 'current_state'
    value = result['trace'][0]['result']['soc_percent']
    assert f'{value:g}%' in result['reference'] or f'{value:.1f}%' in result['reference']
    assert validate_answer('电池电量0.4。', [result], '储能SOC多少')[1]


def test_hvac_requires_all_excluded_times_and_reasons():
    d, r = fixture()
    result = tools.run_tool('hvac_compare', {'setpoint_c': 24}, d, r, '2026-10-13', '14:00',
                            2, threading.Event(), '空调改到24度能省多少钱')
    good, issues = validate_answer(result['reference'], [result], '空调改到24度能省多少钱')
    assert not issues
    from src.agent.chat_sentence_stream import exclusion_present
    assert all(exclusion_present(good,e) for e in result['trace'][-1]['result']['excluded'])
    bad = result['reference'].replace('次日 14:00（预测变化较大）', '')
    assert any(i.get('reason') == 'excluded_time_or_reason_missing' for i in validate_answer(bad, [result])[1])


def test_deadline_separation_and_post_tool_cap():
    p = Fake([{'calls': [call('current_state')]}, {'content': '当前储能电量 36.4%。'}])
    d, r = fixture();out = consume(runner.events('SOC是多少', d, r, p))
    assert 0 < p.requests[0][2] <= 10  # prefetch already counts as post-tool
    assert p.requests[0][3] == 10
    assert p.requests[1][2] <= 10 and out['mode'] == 'llm'


def test_first_token_timeout_one_retry_only(monkeypatch):
    class Timeout(Fake):
        def agent_stream(self, *args):
            self.requests.append(args)
            yield {'kind': 'failure', 'reason': 'first_token_timeout'}
    p = Timeout([]);d, r = fixture()
    out = consume(runner.events('SOC', d, r, p))
    assert len(p.requests) == 1 and out['mode'] == 'fallback' and out['known']
    # With no available local result the single retry is still permitted.
    p = Timeout([])
    consume(runner.events('你好', d, r, p))
    assert len(p.requests) == 2


def test_post_token_can_run_longer_than_first_deadline(monkeypatch):
    monkeypatch.setattr(runner, 'FIRST_TOKEN_SECONDS', .03)
    class Slow(Fake):
        def agent_stream(self, *args):
            yield {'kind': 'first_token'}
            time.sleep(.05)
            yield {'kind': 'message', 'message': {'content': '你好。'}}
    p = Slow([])
    out = consume(runner.request(p, [], [], time.monotonic() + .2, runner.ProgressClock(), p._chat_cancel))
    assert out['kind'] == 'message'


def test_time_tool_required_and_dates_not_thousand_formatted():
    assert validate_answer('现在14:00。', [], '现在几点')[1]
    assert validate_answer('今天2026-10-13。', [], '普通常识')[0] == '今天2026-10-13。'


def test_context_is_session_and_snapshot_scoped():
    d, r = fixture()
    key = runner.scope_key(d, r, '2026-10-13', '14:00', 'a')
    token = runner.save_context(key, [{'data': 'trusted'}])
    assert runner.load_context(token, key)
    assert not runner.load_context(token, runner.scope_key(d, r, '2026-10-13', '14:00', 'b'))
    assert not runner.load_context(token, runner.scope_key(d, r, '2026-10-13', '15:00', 'a'))
