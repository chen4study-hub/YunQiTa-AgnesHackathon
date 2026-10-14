import threading
import pytest
from src.agent import agent_runner as runner, agent_tools as tools
from src.agent.agent_public import weather_question, timely_public_question
from src.agent.chat_engine import consume
from tests.test_agent_v3 import fixture, Fake, call


@pytest.fixture(autouse=True)
def no_official_network(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'lookup', lambda *a, **k: None)


def result():
    # Fictional test names only; never used as acceptance evidence.
    return {'status': 'ok', 'answer': None, 'sources': [
        {'title': '2026 年物理学奖', 'url': 'https://www.nobelprize.org/test/2026',
         'snippet': '2026 年物理学奖：Fixture Laureate。'}]}


def test_default_search_visible():
    assert 'web_search' in {t['function']['name'] for t in tools.available_tools()}
    assert 'city_weather' not in {t['function']['name'] for t in tools.available_tools()}
    assert '知识可能过时' in runner.SYSTEM and '不许要求用户自己提供' in runner.SYSTEM


@pytest.mark.parametrize('answer', [None, '暂时没有查到相关公开资料。'])
def test_sources_without_aggregate_answer_keep_snippets(answer):
    raw = result(); raw['answer'] = answer
    text = tools.public_reference(raw)
    assert 'Fixture Laureate' in text and raw['sources'][0]['url'] in text
    assert '没查到' not in text and '没有查到' not in text


def test_empty_and_sources_without_snippets_do_not_invent_names():
    assert '没有查到' in tools.public_reference({'sources': []})
    raw = result(); raw['sources'][0].pop('snippet')
    text = tools.public_reference(raw)
    assert '摘要没有提供' in text and 'Fixture Laureate' not in text


@pytest.mark.parametrize('question', ['2026年诺奖得主 联网查询', '2026年诺奖得主',
                                    '2026年杭州马拉松男子冠军是谁', '2027年诺贝尔物理学奖得主'])
def test_timely_public_requires_query_not_weather(question):
    assert timely_public_question(question) and not weather_question(question)


def test_local_regressions_not_public():
    assert not timely_public_question('今天储能SOC多少')
    assert not timely_public_question('当前总负荷是多少')
    assert not timely_public_question('现在电价多少？')
    assert not timely_public_question('联网查现在电价多少')
    assert not timely_public_question('现在几点')
    assert not timely_public_question('那今天几号？')
    assert weather_question('北京明天天气如何')


def test_adapter_rejects_nonweather_before_io(monkeypatch):
    from src.agent import city_weather
    monkeypatch.setattr(city_weather, 'query', lambda *a, **k: pytest.fail('unexpected weather I/O'))
    d, r = fixture()
    assert not tools.run_tool('city_weather', {'city': '北京'}, d, r, '2026-10-13', '14:00', 2,
                              threading.Event(), '2026年诺奖得主')['success']


def test_model_and_prefetch_weather_rejected(monkeypatch):
    d, r = fixture(); ran = []
    monkeypatch.setattr(runner, 'prefetch_plan', lambda q: ([{'name': 'city_weather', 'args': {'city': '北京'}, 'question': q}], {'internet'}))
    monkeypatch.setattr(runner, 'run_tool', lambda *a: ran.append(a))
    p = Fake([{'calls': [call('city_weather', city='北京')]}, {'content': '这是常识问答。'}])
    out = consume(runner.events('物理学奖是什么意思', d, r, p))
    assert not ran and not out['tool_trace']


def test_public_host_lookup_gated_and_denial_uses_source_reference(monkeypatch):
    from src.agent import web_search
    calls = []
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: (calls.append(a), result())[1])
    d, r = fixture(); p = Fake([{'content': '没有查到相关资料。'}])
    g = runner.events('2026年诺奖得主', d, r, p, '2026-10-13', '14:00')
    start = next(g)
    assert start['type'] == 'tool_start' and start['tool'] == 'web_search' and not calls
    out = consume(g)
    assert len(calls) == 1 and 'Fixture Laureate' in out['answer'] and '没查到' not in out['answer']
    assert out['llm_reason'] == 'public_source_reference'


def test_timeout_source_fallback_and_links(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: result())
    d, r = fixture(); p = Fake([])
    out = consume(runner.events('2026年杭州马拉松男子冠军是谁', d, r, p))
    assert 'Fixture Laureate' in out['answer'] and 'https://' in out['answer']


def test_empty_query_never_asks_model_or_repeats_unsupported_answer(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: {
        'status': 'empty', 'sources': [], 'answer': '尚未举行，通常11月。'})
    d, r = fixture(); p = Fake([{'content': '尚未举行，通常11月。'}])
    out = consume(runner.events('2026年杭州马拉松男子冠军是谁', d, r, p))
    assert out['answer'] == '暂时没有查到相关公开资料。'
    assert not p.requests and not out['llm_called']
    assert tools.public_reference({'sources': [], 'answer': '名单尚未产生'}) == out['answer']


@pytest.mark.parametrize('clock', ['14:00', '22:10'])
def test_current_tariff_reference_no_search_or_model(monkeypatch, clock):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: pytest.fail('local tariff must not use network'))
    d, r = fixture(); p = Fake([{'calls': [call('web_search', query='电价')]}])
    out = consume(runner.events('现在电价多少？', d, r, p, '2026-10-13', clock))
    assert [t['tool'] for t in out['tool_trace']] == ['tariff_periods']
    assert not p.requests and not out['llm_called']
    if clock == '22:10':
        assert '次日 00:00' in out['answer'] and '0.35 元/kWh' in out['answer']
        assert '明晚' not in out['answer']


def test_local_model_cannot_search_even_if_asked(monkeypatch):
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: pytest.fail('local reading network'))
    d, r = fixture(); p = Fake([{'calls': [call('web_search', query='云栖塔总负荷')]},
                              {'content': '当前总负荷 1,258.1 kW。'}])
    out = consume(runner.events('当前总负荷是多少', d, r, p))
    assert 'web_search' not in {t['tool'] for t in out['tool_trace']}
    assert all('web_search' not in {t['function']['name'] for t in req[1]} for req in p.requests)
    raw = tools.run_tool('web_search', {'query': '电价'}, d, r, '2026-10-13', '22:10', 2,
                         threading.Event(), '现在电价多少？')
    assert not raw['success'] and raw['trace'] == []


def test_six_official_sources_survive_ranked_cap_and_gate(monkeypatch):
    from src.agent import web_search
    cats = ['化学奖', '经济学奖', '文学奖', '生理学或医学奖', '和平奖', '物理学奖']
    sources = [{'title': '2026 年' + cat, 'snippet': cat + '：Fixture Laureate。',
                'url': f'https://api.nobelprize.org/2/nobelPrize/test{i}/2026'} for i, cat in enumerate(cats)]
    calls = []
    monkeypatch.setattr(web_search, 'lookup', lambda *a: (calls.append(a), {'status': 'ok', 'sources': sources})[1])
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: pytest.fail('official results must bypass five-source cap'))
    d, r = fixture(); p = Fake([])
    g = runner.events('2026年诺奖得主', d, r, p)
    start = next(g)
    assert start['tool'] == 'web_search' and not calls
    out = consume(g)
    assert len(out['tool_trace'][0]['result']['sources']) == 6
    assert all(c in out['answer'] for c in cats) and not p.requests
    assert not any(t.name == 'agent-official-nobel' for t in threading.enumerate())


def test_official_failure_keeps_generic_fallback_budget(monkeypatch):
    from src.agent import web_search
    from src.agent.agent_public import search_public
    seen = []
    monkeypatch.setattr(web_search, 'search', lambda *a, **kw: (seen.append(kw['seconds']), result())[1])
    raw = search_public('2026年诺奖得主', .5, threading.Event())
    assert raw['sources'] and 0 < seen[0] <= .5
    stop = threading.Event(); stop.set()
    assert not search_public('2026年诺奖得主', .5, stop)['sources']
