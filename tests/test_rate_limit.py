"""Rate-limit contracts without Redis/network services or deployment secrets."""
import importlib
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
import httpx
import pytest
from fastapi.testclient import TestClient
from src.api import rate_limit as rl
from src.agent import provider, topic_guard

api = importlib.import_module('src.api.app')


class Clock:
    def __init__(self, now=86410):
        self.now = now

    def __call__(self):
        return self.now


class FakeRedis:
    """Independent in-memory implementation of the script's Redis contract."""
    def __init__(self, clock):
        self.clock, self.lock = clock, threading.Lock()
        self.data, self.expires, self.calls = {}, {}, []
        self.down = False
        self.recoveries = set()

    def eval(self, script, numkeys, prefix, reserve, *args):
        assert script in (rl.SCRIPT, rl.RECOVER_SCRIPT) and numkeys == 1
        with self.lock:
            self.calls.append((prefix, args))
            if self.down:
                raise ConnectionError('private address must never be logged')
            now = int(self.clock())
            if script == rl.RECOVER_SCRIPT:
                marker = reserve  # First argument is the idempotent batch ID.
                if marker not in self.recoveries:
                    for i in range(0, len(args), 3):
                        name, count, expires = args[i:i+3]
                        if expires > now:
                            key = prefix+name
                            if self.expires.get(key, now+1) <= now:
                                self.data.pop(key, None)
                            self.data[key] = self.data.get(key, 0)+count
                            self.expires[key] = expires
                    self.recoveries.add(marker)
                return 1
            keys, counts, ttls, wait = [], [], [], 0
            for i in range(0, len(args), 3):
                name, seconds, limit = args[i:i+3]
                offset = 28800 if seconds == 86400 else 0
                key = f'{prefix}{name}:{(now+offset)//seconds}'
                if self.expires.get(key, now+1) <= now:
                    self.data.pop(key, None)
                count, ttl = self.data.get(key, 0), seconds-(now+offset)%seconds
                keys.append(key); counts.append(count); ttls.append(ttl)
                if count >= limit:
                    wait = max(wait, ttl)
            if reserve and not wait:
                counts = [n+1 for n in counts]
                for key, count, ttl in zip(keys, counts, ttls):
                    self.data[key], self.expires[key] = count, now+ttl
            return [wait, now, *counts]


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    for key in ('RATE_LIMIT_REDIS_URL', 'RATE_LIMIT_IP_PER_MINUTE',
                'RATE_LIMIT_IP_PER_DAY', 'RATE_LIMIT_LLM_PER_DAY'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('LLM_MODE', 'demo')
    monkeypatch.setenv('CHAT_AGENT_LOOP', '0')
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(redis_client=None))
    monkeypatch.setattr(topic_guard, '_TERMINATED', set())
    monkeypatch.setattr(topic_guard, 'record_chat_event', lambda *a, **kw: 1)


def real_mode(monkeypatch):
    monkeypatch.setenv('LLM_MODE', 'real')
    monkeypatch.setenv('LLM_API_KEY', 'unit-test-placeholder')
    monkeypatch.setenv('LLM_BASE_URL', 'https://example.test/v1')
    monkeypatch.setenv('LLM_MODEL', 'test')


def body():
    return dict(question='现在几点', scenario='normal', origin='2017-10-23T14:00:00-05:00',
                display_date='2026-10-14', display_time='14:00', session_id=None)


def result(response, endpoint):
    assert response.status_code == 200
    if endpoint == '/chat':
        return response.json(), response.json()['answer']
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert not any(e['type'] == 'error' for e in events)
    return events[-1], ''.join(e.get('text', '') for e in events if e['type'] == 'answer_delta')


@pytest.mark.parametrize('backend', ['memory', 'redis'])
def test_shared_endpoints_ip_isolation_and_429_before_stream(monkeypatch, backend):
    clock = Clock()
    fake = FakeRedis(clock) if backend == 'redis' else None
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(2, 20, 100), redis_client=fake, clock=clock))
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='test'))
    a = TestClient(api.app, client=('192.0.2.1', 1000))
    b = TestClient(api.app, client=('192.0.2.2', 1000))
    assert a.post('/chat', json=body()).status_code == 200
    assert a.post('/chat/stream', json=body()).status_code == 200
    for endpoint in ('/chat', '/chat/stream'):
        response = a.post(endpoint, json=body(), headers={'X-Forwarded-For': '192.0.2.99', 'X-Real-IP': '192.0.2.98'})
        assert response.status_code == 429
        assert response.headers['Retry-After'] == '50'
        assert response.json()['detail']['wait_seconds'] == 50
        assert '等待' in response.json()['detail']['message']
        assert 'text/event-stream' not in response.headers['content-type']
    assert b.post('/chat', json=body()).status_code == 200
    clock.now += 50
    assert a.post('/chat', json=body()).status_code == 200


@pytest.mark.parametrize('backend', ['memory', 'redis'])
def test_day_limit_and_shanghai_reset(backend):
    clock = Clock(86400+86400-28800-10)  # Shanghai 23:59:50
    fake = FakeRedis(clock) if backend == 'redis' else None
    limit = rl.RateLimiter(rl.Limits(10, 1, 1), redis_client=fake, clock=clock)
    assert limit.check_ip('a') == 0
    assert limit.check_ip('a') == 10
    assert limit.check_ip('b') == 0
    assert limit.take_llm() and not limit.take_llm()
    clock.now += 10
    assert limit.check_ip('a') == 0 and limit.take_llm()
    if fake:
        assert fake.expires and all(e > 0 for e in fake.expires.values())


@pytest.mark.parametrize('backend', ['memory', 'redis'])
def test_concurrent_global_reservations_never_exceed_cap(backend):
    clock = Clock()
    fake = FakeRedis(clock) if backend == 'redis' else None
    workers = [rl.RateLimiter(rl.Limits(10, 200, 7), redis_client=fake, clock=clock)
               for _ in range(4 if fake else 1)]
    with ThreadPoolExecutor(max_workers=16) as pool:
        accepted = list(pool.map(lambda i: workers[i % len(workers)].take_llm(), range(64)))
    assert sum(accepted) == 7


def test_redis_outage_preserves_usage_and_warns_only_once(monkeypatch, caplog):
    clock, fake = Clock(), FakeRedis(Clock())
    limit = rl.RateLimiter(rl.Limits(1, 10, 1), redis_client=fake, clock=clock)
    monkeypatch.setattr(rl, '_limiter', limit)
    assert limit.check_ip('192.0.2.1') == 0 and limit.take_llm()
    fake.down = True
    with caplog.at_level(logging.WARNING, logger=rl.__name__):
        assert limit.check_ip('192.0.2.1') == 50
        assert not limit.take_llm()
        assert limit.check_ip('192.0.2.2') == 0
        for _ in range(4):
            assert limit.check_ip('192.0.2.2') == 50
    assert caplog.text.count('using process-local memory') == 1
    assert 'private address' not in caplog.text
    assert len(fake.calls) == 3  # No repeated connection attempts within 60 seconds.


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
def test_outage_from_first_request_still_limits_http(monkeypatch, caplog, endpoint):
    clock = Clock()
    fake = FakeRedis(clock); fake.down = True
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(1, 10, 2), redis_client=fake, clock=clock))
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='test'))
    with caplog.at_level(logging.WARNING, logger=rl.__name__):
        client = TestClient(api.app, client=('192.0.2.1', 1000))
        assert client.post(endpoint, json=body()).status_code == 200
        response = client.post(endpoint, json=body())
        assert response.status_code == 429 and response.headers['Retry-After'] == '50'
    assert caplog.text.count('using process-local memory') == 1


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
@pytest.mark.parametrize('loop', ['0', '1'])
def test_global_cap_keeps_local_answers_and_never_opens_llm(monkeypatch, endpoint, loop):
    real_mode(monkeypatch)
    monkeypatch.setenv('CHAT_AGENT_LOOP', loop)
    clock = Clock()
    fake = FakeRedis(clock)
    limit = rl.RateLimiter(rl.Limits(10, 200, 1), redis_client=fake, clock=clock)
    monkeypatch.setattr(rl, '_limiter', limit)
    assert limit.take_llm()
    assert provider.get_llm_status()['mode'] == 'real'  # configuration is not the request's quota decision
    with TestClient(api.app) as client:
        # Patch after creating TestClient; httpx.Client also constructs the test client.
        monkeypatch.setattr(provider.httpx, 'Client', lambda *a, **kw: pytest.fail('LLM transport forbidden'))
        out, answer = result(client.post(endpoint, json=body()), endpoint)
    assert '14:00' in answer and out['known']
    assert out.get('mode', 'fallback') == 'fallback' and out['explanation_source'] == 'template'
    assert out.get('llm_mode', 'rule') != 'real'
    assert not out.get('llm_called', False)
    assert fake.data['rate-limit:v2:llm:day:1'] == 1


def test_environment_defaults_and_overrides(monkeypatch):
    assert rl.Limits.from_env() == rl.Limits(10, 200, 2000)
    assert rl.RateLimiter().redis_url == ''
    monkeypatch.setenv('RATE_LIMIT_IP_PER_MINUTE', '3')
    monkeypatch.setenv('RATE_LIMIT_IP_PER_DAY', '40')
    monkeypatch.setenv('RATE_LIMIT_LLM_PER_DAY', '0')
    assert rl.Limits.from_env() == rl.Limits(3, 40, 0)
    monkeypatch.setenv('RATE_LIMIT_IP_PER_MINUTE', 'bad')
    assert rl.Limits.from_env().ip_minute == 10


def test_url_client_construction_failure_falls_back_without_secrets(monkeypatch, caplog):
    import sys
    from types import SimpleNamespace
    def fail(*a, **kw):
        assert kw['socket_timeout'] == .2 and kw['socket_connect_timeout'] == .2
        raise ValueError('private Redis configuration')
    monkeypatch.setitem(sys.modules, 'redis', SimpleNamespace(Redis=SimpleNamespace(from_url=fail)))
    limit = rl.RateLimiter(rl.Limits(1, 10, 1), redis_url='redis://example.invalid', clock=Clock())
    with caplog.at_level(logging.WARNING, logger=rl.__name__):
        assert limit.check_ip('a') == 0 and limit.check_ip('a') == 50
    assert caplog.text.count('using process-local memory') == 1 and 'private Redis' not in caplog.text


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
@pytest.mark.parametrize('backend', ['memory', 'redis'])
def test_daily_http_limit_returns_wait_until_midnight(monkeypatch, endpoint, backend):
    clock = Clock(86400-28800+120)  # Shanghai 00:02
    fake = FakeRedis(clock) if backend == 'redis' else None
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 1, 2000), redis_client=fake, clock=clock))
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='test'))
    client = TestClient(api.app)
    assert client.post(endpoint, json=body()).status_code == 200
    clock.now += 60  # A new minute does not reset the daily count.
    response = client.post(endpoint, json=body())
    assert response.status_code == 429
    assert response.headers['Retry-After'] == '86220'
    assert response.json()['detail']['wait_seconds'] == 86220


def test_empty_redis_url_never_imports_client(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, 'redis', None)
    limit = rl.RateLimiter(rl.Limits(1, 2, 1), redis_url='', clock=Clock())
    assert limit.check_ip('a') == 0 and limit.check_ip('a') == 50
    assert not limit.failed


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
def test_one_question_reservation_covers_classification_and_native_rounds(monkeypatch, endpoint):
    real_mode(monkeypatch)
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 1), redis_client=fake))
    from src.agent import web_search
    monkeypatch.setattr(web_search, 'search', lambda *a, **kw: dict(
        sources=[dict(title='测试资料', url='https://example.test/source')], answer='节能有助于减少浪费。'))
    calls, rounds = [], []
    def handle(request):
        payload = json.loads(request.content); calls.append(payload)
        choice = payload.get('tool_choice')
        if isinstance(choice, dict) and choice.get('function', {}).get('name') == 'classify_topic':
            return httpx.Response(200, json={'choices': [{'message': {'tool_calls': [{'function': {
                'name': 'classify_topic', 'arguments': json.dumps({'category': 'none', 'reason': 'test'})}}]}}]})
        rounds.append(payload)
        if len(rounds) == 1:
            delta = {'tool_calls': [{'index': 0, 'function': {'name': 'web_search', 'arguments': json.dumps({'query': '节能知识'})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': '节能有助于减少浪费。'}, 'stop'
        wire = 'data: '+json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]})+'\n\ndata: [DONE]\n\n'
        return httpx.Response(200, text=wire)
    real_client = httpx.Client
    with TestClient(api.app) as client:
        monkeypatch.setattr(provider.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
        payload = {**body(), 'question': '什么是节能'}
        out, answer = result(client.post(endpoint, json=payload), endpoint)
        assert '减少浪费' in answer and out['explanation_source'] == 'llm'
        assert len(calls) == 3 and len(rounds) == 2
        assert fake.data['rate-limit:v2:llm:day:1'] == 1
        out, answer = result(client.post(endpoint, json=payload), endpoint)
        assert out.get('mode', 'fallback') == 'fallback'
        assert out['explanation_source'] == 'template'
        assert len(calls) == 3  # Next question is local; current question was not interrupted.
    reservations = [args for _, args in fake.calls if args[0] == 'llm:day']
    assert len(reservations) == 2  # One admitted, one denied; no phase-level lookups.


def test_entry_atomic_admission_is_shared_across_workers(monkeypatch):
    real_mode(monkeypatch)
    clock = Clock()
    fake = FakeRedis(clock)
    # The separate-worker atomic case is covered above; exercise entry helper too.
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 7), redis_client=fake, clock=clock))
    with ThreadPoolExecutor(max_workers=16) as pool:
        providers = list(pool.map(lambda i: rl.admit_chat_provider(provider.OpenAICompatibleProvider, provider.get_llm_status), range(64)))
    assert sum(p._rate_limit_llm_status['mode'] == 'real' for p in providers) == 7
    assert fake.data['rate-limit:v2:llm:day:1'] == 7
    # Reading an admitted decision never sees the now-exhausted shared counter.
    for p in providers:
        for _ in range(3):
            assert rl.chat_llm_status(p, lambda: pytest.fail('must retain entry decision')) == p._rate_limit_llm_status
    assert len(fake.calls) == 64


@pytest.mark.parametrize('kind', ['agent', 'topic', 'short_topic', 'chat_call', 'chat_stream'])
def test_local_entry_decision_blocks_all_transports_without_extra_counters(monkeypatch, kind):
    from src.agent.agent_provider import AgentProvider
    from src.agent.topic_provider import TopicClassificationProvider
    real_mode(monkeypatch)
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 0), redis_client=fake))
    p = rl.admit_chat_provider(AgentProvider if kind == 'agent' else
                             TopicClassificationProvider if kind == 'topic' else
                             provider.OpenAICompatibleProvider, provider.get_llm_status)
    monkeypatch.setattr(provider.httpx, 'Client', lambda *a, **kw: pytest.fail('local question must not open transport'))
    if kind == 'agent':
        assert list(p.agent_stream([], [], 1.))[-1]['kind'] == 'failure'
    elif kind == 'topic':
        assert list(p.agent_stream([], [{'function': {'name': 'classify_topic'}}], 1.))[-1]['kind'] == 'failure'
    elif kind == 'short_topic':
        with pytest.raises(ValueError):
            topic_guard._classify_short(p, {}, 1.)
    elif kind == 'chat_call':
        assert p.chat_call('general', {})['result'] is None
    else:
        assert list(p.chat_stream({}))[-1]['llm']['mode'] == 'rule'
    assert len(fake.calls) == 1


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
def test_public_questions_do_not_reserve_global_llm_budget(monkeypatch, endpoint):
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 1), redis_client=fake))
    client = TestClient(api.app)
    out, answer = result(client.post(endpoint, json=body()), endpoint)
    assert '14:00' in answer
    assert not any(args[0] == 'llm:day' for _, args in fake.calls)
    assert not any('llm:day' in key for key in fake.data)


def test_ip_rejection_does_not_reserve_llm_question(monkeypatch):
    real_mode(monkeypatch)
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(1, 200, 10), redis_client=fake))
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='test'))
    client = TestClient(api.app)
    assert client.post('/chat', json=body()).status_code == 200
    assert fake.data['rate-limit:v2:llm:day:1'] == 1
    assert client.post('/chat/stream', json=body()).status_code == 429
    assert fake.data['rate-limit:v2:llm:day:1'] == 1


def test_admitted_question_retries_and_phases_never_recheck_budget(monkeypatch):
    real_mode(monkeypatch)
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 1), redis_client=fake))
    p = rl.admit_chat_provider(provider.OpenAICompatibleProvider, provider.get_llm_status)
    assert fake.data['rate-limit:v2:llm:day:1'] == 1
    calls = []
    def handle(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(500)
        return httpx.Response(200, json={'choices': [{'message': {'tool_calls': [{'function': {
            'name': 'chat_general', 'arguments': json.dumps({'answer': '你好。'})}}]}}]})
    real_client = httpx.Client
    monkeypatch.setattr(provider.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
    monkeypatch.setattr(provider.time, 'sleep', lambda *a: None)
    for _ in range(2):
        assert p.chat_call('general', {'question': '你好'})['result']['answer'] == '你好。'
    assert len(calls) == 3 and len(fake.calls) == 1
    assert fake.data['rate-limit:v2:llm:day:1'] == 1


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/stream'])
def test_native_agent_question_retains_last_slot_through_tool_round(monkeypatch, endpoint):
    real_mode(monkeypatch)
    monkeypatch.setenv('CHAT_AGENT_LOOP', '1')
    fake = FakeRedis(Clock())
    monkeypatch.setattr(rl, '_limiter', rl.RateLimiter(rl.Limits(10, 200, 1), redis_client=fake))
    calls, rounds = [], []
    def handle(request):
        payload = json.loads(request.content); calls.append(payload)
        choice = payload.get('tool_choice')
        if isinstance(choice, dict):
            return httpx.Response(200, json={'choices': [{'message': {'tool_calls': [{'function': {
                'name': 'classify_topic', 'arguments': json.dumps({'category': 'none', 'reason': 'test'})}}]}}]})
        rounds.append(payload)
        if len(rounds) == 1:
            delta = {'tool_calls': [{'index': 0, 'function': {'name': 'current_state', 'arguments': '{}'}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': '储能电量36.4%。'}, 'stop'
        wire = 'data: '+json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]})+'\n\ndata: [DONE]\n\n'
        return httpx.Response(200, text=wire)
    real_client = httpx.Client
    with TestClient(api.app) as client:
        monkeypatch.setattr(provider.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw))
        payload = {**body(), 'question': 'SOC多少'}
        out, answer = result(client.post(endpoint, json=payload), endpoint)
        assert '36.4%' in answer and out['mode'] == 'llm'
        assert len(rounds) == 2 and len(calls) == 3
        assert fake.data['rate-limit:v2:llm:day:1'] == 1
    assert sum(args[0] == 'llm:day' for _, args in fake.calls) == 1


@pytest.mark.parametrize('backend', ['memory', 'redis'])
def test_utc_midnight_does_not_reset_shanghai_day(backend):
    clock = Clock(2*86400-10)  # Shanghai 07:59:50
    fake = FakeRedis(clock) if backend == 'redis' else None
    limit = rl.RateLimiter(rl.Limits(10, 1, 1), redis_client=fake, clock=clock)
    assert limit.check_ip('a') == 0 and limit.take_llm()
    clock.now += 10  # UTC midnight, Shanghai 08:00
    assert limit.check_ip('a') == 16*3600 and not limit.take_llm()
    clock.now += 16*3600  # Shanghai midnight
    assert limit.check_ip('a') == 0 and limit.take_llm()
    assert all(rl.window_end(key) > clock.now for key in limit.memory.counts)


def test_reconnect_cadence_repeated_outages_warn_once_and_preserve_increments(caplog):
    clock, retry = Clock(), Clock(0)
    fake = FakeRedis(clock)
    limit = rl.RateLimiter(rl.Limits(10, 3, 3), redis_client=fake, clock=clock, retry_clock=retry)
    assert limit.check_ip('a') == 0 and limit.take_llm()  # Shared count 1.
    fake.down = True
    with caplog.at_level(logging.WARNING, logger=rl.__name__):
        assert limit.check_ip('a') == 0 and limit.take_llm()  # Local count 2.
        attempts = len(fake.calls)
        retry.now = 59
        assert limit.check_ip('a') == 0 and limit.take_llm()  # Local count 3.
        assert len(fake.calls) == attempts
        retry.now = 60
        assert limit.check_ip('a') > 0  # One bounded retry, still disconnected.
        attempts = len(fake.calls)
        retry.now = 119
        fake.down = False
        assert not limit.take_llm() and len(fake.calls) == attempts
        retry.now = 120
        assert not limit.take_llm() and not limit.failed  # Recover even when at cap.
        assert fake.data['rate-limit:v2:llm:day:1'] == 3
        assert limit.check_ip('a') > 0
        assert not limit.memory.pending and limit.recovery_batch is None
        # A second outage/recovery never emits a second warning.
        fake.down = True
        assert not limit.take_llm()
        fake.down = False
        retry.now = 180
        assert not limit.take_llm() and not limit.failed
    assert caplog.text.count('using process-local memory') == 1
    # A new worker sees exactly shared 1 + fallback 2, not the mirrored totals.
    peer = rl.RateLimiter(rl.Limits(10, 3, 3), redis_client=fake, clock=clock)
    assert peer.check_ip('a') > 0 and not peer.take_llm()


def test_recovery_is_idempotent_after_response_lost():
    clock, retry = Clock(), Clock(0)
    class LostResponse(FakeRedis):
        lose_once = True
        def eval(self, script, *args):
            result = super().eval(script, *args)
            if script == rl.RECOVER_SCRIPT and self.lose_once:
                self.lose_once = False
                raise ConnectionError('recovery applied but response lost')
            return result
    fake = LostResponse(clock); fake.down = True
    limit = rl.RateLimiter(rl.Limits(10, 10, 10), redis_client=fake, clock=clock, retry_clock=retry)
    assert limit.take_llm()  # First fallback question.
    fake.down = False; retry.now = 60
    assert limit.take_llm() and limit.failed  # Applied batch 1; fallback question 2.
    assert fake.data['rate-limit:v2:llm:day:1'] == 1
    retry.now = 120
    assert limit.take_llm() and not limit.failed  # Retry batch 1, merge batch 2, shared question 3.
    assert fake.data['rate-limit:v2:llm:day:1'] == 3
    assert len(fake.recoveries) == 2


def test_recovery_discards_expired_windows_at_shanghai_midnight():
    clock, retry = Clock(2*86400-28800-10), Clock(0)
    fake = FakeRedis(clock); fake.down = True
    limit = rl.RateLimiter(rl.Limits(10, 1, 1), redis_client=fake, clock=clock, retry_clock=retry)
    assert limit.check_ip('a') == 0 and limit.take_llm()
    clock.now += 60; retry.now = 60; fake.down = False
    assert limit.check_ip('a') == 0 and limit.take_llm()
    assert not limit.failed
    assert fake.data['rate-limit:v2:llm:day:2'] == 1
    assert not any('llm:day:1' in key for key in fake.data)


def test_concurrent_recovery_runs_one_merge_before_switching_to_redis():
    clock, retry = Clock(), Clock(0)
    fake = FakeRedis(clock); fake.down = True
    limit = rl.RateLimiter(rl.Limits(10, 200, 7), redis_client=fake, clock=clock, retry_clock=retry)
    assert limit.take_llm()
    fake.down = False; retry.now = 60
    with ThreadPoolExecutor(max_workers=16) as pool:
        accepted = list(pool.map(lambda i: limit.take_llm(), range(32)))
    assert sum(accepted) == 6 and not limit.failed
    assert fake.data['rate-limit:v2:llm:day:1'] == 7
    assert len(fake.recoveries) == 1



def test_client_construction_recovers_after_retry_delay(monkeypatch):
    import sys
    from types import SimpleNamespace
    clock, retry = Clock(), Clock(0)
    fake, attempts = FakeRedis(clock), []
    def connect(*args, **kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError('not logged')
        return fake
    monkeypatch.setitem(sys.modules, 'redis', SimpleNamespace(Redis=SimpleNamespace(from_url=connect)))
    limit = rl.RateLimiter(rl.Limits(10, 200, 3), redis_url='redis://example.invalid',
                           clock=clock, retry_clock=retry)
    assert limit.take_llm() and limit.failed
    retry.now = 59
    assert limit.take_llm() and len(attempts) == 1
    retry.now = 60
    assert limit.take_llm() and len(attempts) == 2 and not limit.failed
    assert fake.data['rate-limit:v2:llm:day:1'] == 3
