"""Probe-only tests; no API changes and no real network."""
import importlib.util
import json
from pathlib import Path
import sys
import httpx

PATH = Path(__file__).resolve().parents[1] / 'latency_probe.py'
spec = importlib.util.spec_from_file_location('draft_latency_probe', PATH)
probe = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = probe
spec.loader.exec_module(probe)


def test_factorial_catalogue_and_invariant_parameters():
    full = probe.catalogue('all', 'original')
    common = probe.catalogue('common', 'short')
    # 84c1ed3 adds tariff_periods to the native catalogue; common six unchanged.
    assert len(full) == 21 and len(common) == 6
    assert "tariff_periods" in {t["function"]["name"] for t in full}
    assert {t['function']['name'] for t in common} == set(probe.COMMON)
    for t in common:
        original = next(f for f in full if f['function']['name'] == t['function']['name'])
        assert original['function']['parameters'] == t['function']['parameters']
        assert len(t['function']['description']) <= len(original['function']['description'])
    assert probe.catalogue('all', 'original') == full


def test_transport_records_response_and_no_secret(monkeypatch):
    monkeypatch.setattr(probe.transport, 'read_key', lambda: ('test-only-secret', 'available'))
    monkeypatch.setattr(probe.transport, 'get_llm_status', lambda: {'mode': 'real'})
    monkeypatch.setenv('LLM_BASE_URL', 'https://example.test/v1')
    monkeypatch.setenv('LLM_MODEL', 'test')
    def handle(request):
        body = json.loads(request.content)
        assert body['stream'] and len(body['tools']) == 6
        chunks = [{'choices': [{'delta': {'content': '你好！'}, 'finish_reason': None}]},
                  {'choices': [{'delta': {}, 'finish_reason': 'stop'}]}]
        content = ''.join('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n' for c in chunks)
        return httpx.Response(200, content=content + 'data: [DONE]\n\n')
    real = httpx.Client
    monkeypatch.setattr(probe.httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handle), **kw))
    provider = probe.MeasuredProvider(30.)
    value = provider.request([{'role': 'user', 'content': 'hello'}], probe.catalogue('common', 'short'), 30.)
    assert value['content'] == '你好！'
    metric = provider.calls[0]
    assert metric['first_response_ms'] is not None and metric['complete']
    assert metric['headers_ms'] <= metric['total_ms']
    assert 'test-only-secret' not in str(metric)


def test_acknowledgement_never_counts_as_answer(monkeypatch):
    values = iter([{'content': '我先看一下。', 'calls': [{'name': 'get_time', 'arguments': '{}'}]}, None, None])
    class Fake:
        def __init__(self, *a): self.calls = []
        def request(self, *a):
            self.calls.append({})
            return next(values)
    monkeypatch.setattr(probe, 'MeasuredProvider', Fake)
    result = probe.run_case(probe.CASES[0], 'common', 'short', True, 30.)
    assert result['acknowledgements'] == ['我先看一下。']
    assert not result['success'] and result['answer'] == ''
    assert 'empty_answer' in result['failure_reasons']
