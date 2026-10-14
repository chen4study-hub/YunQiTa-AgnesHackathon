"""Characterize existing timeout/template/error behavior; no live provider calls."""
import asyncio
import threading
import time
from src.agent import chat_engine, chat_sentence_stream as sentences
from src.agent.chat_tools import execute
from src.api.async_runtime import ChatPool
from src.data.replay_payload import load_replay


class SilentProvider:
    def __init__(self):
        self._chat_cancel = threading.Event()
    def chat_stream(self, payload):
        self._chat_cancel.wait(1)
        if False:
            yield None
    def cancel_chat(self):
        self._chat_cancel.set()


def drain(generator):
    events = []
    while True:
        try:
            events.append(next(generator))
        except StopIteration as end:
            return events, end.value


def test_no_first_token_uses_verified_reference_and_is_not_model_answer(monkeypatch):
    monkeypatch.setattr(sentences, 'FIRST_TOKEN_SECONDS', .05)
    data = load_replay('normal'); row = data['hours'][14]
    result = chat_engine.consume(execute('current_state', '储能电量多少', data, row))
    provider = SilentProvider()
    events, result = drain(sentences.stream_answer(provider, '储能电量多少', 'current_state',
                                                  result, row, time.monotonic()+1))
    assert provider._chat_cancel.is_set()
    assert result['llm']['reason'] == 'chat_first_token_timeout'
    assert result['phase_timings'][0]['first_token_ms'] is None
    assert result['explanation_source'] == 'template' and result['answer']
    assert all(e['sentence_source'] == 'template' for e in events if e['type'] == 'answer_delta')


def test_unusable_reference_exception_returns_error_done_and_no_answer(monkeypatch):
    monkeypatch.setattr(sentences, 'FIRST_TOKEN_SECONDS', .05)
    monkeypatch.setattr(sentences, 'host_supplement', lambda *a: (_ for _ in ()).throw(ValueError('unusable reference')))
    data = load_replay('normal'); row = data['hours'][14]
    result = chat_engine.consume(execute('current_state', '储能电量多少', data, row))
    provider = SilentProvider(); pool = ChatPool(1)
    def pipeline(d, r, p):
        yield from sentences.stream_answer(p, '储能电量多少', 'current_state', result, r, time.monotonic()+1)
    async def observe():
        return [e async for e in pool.events(lambda: (data, row), pipeline, provider)]
    try:
        events = asyncio.run(observe())
    finally:
        pool.executor.shutdown(wait=True)
    assert not any(e['type'] == 'answer_delta' for e in events)
    assert [e['type'] for e in events[-2:]] == ['error', 'done']
    assert events[-2]['message'] == '起报记录或工具数据不可用。'
    assert events[-1]['reason'] == 'no_data' and not events[-1]['known']


def test_prose_repair_failure_counts_rejected_sentence_not_transport_timeout(monkeypatch):
    monkeypatch.setattr(sentences, 'repair_prose', lambda *a: ('', {}))
    diagnostics = {}
    data = load_replay('normal'); row = data['hours'][14]
    assert sentences.safe_sentence('无依据的文字。', 'energy_totals', {}, row, {}, diagnostics) == ''
    assert diagnostics == {'prose_repair_failed': 1}
