import importlib
import threading
import time
import pytest
from src.agent.chat_engine import consume
from src.agent.chat_progress import progress_events
from src.data.replay_payload import load_replay
from src.agent import topic_guard

api = importlib.import_module('src.api.app')


@pytest.mark.parametrize('switch', ['0', '1'])
def test_slow_tool_three_seconds_progress_every_second_before_first_letter(monkeypatch, switch):
    monkeypatch.setenv('CHAT_AGENT_LOOP', switch)
    monkeypatch.setenv('LLM_MODE', 'demo')
    monkeypatch.setattr(topic_guard, 'is_terminated', lambda *a: False)
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: {'category': 'none', 'reason': 'ok'})
    def slow_tool_pipeline(*a, **kw):
        yield {'type': 'tool_start', 'tool': 'current_state', 'args': {}}
        time.sleep(3.1)
        yield {'type': 'tool_end', 'tool': 'current_state', 'ms': 3100., 'summary': '完成'}
        yield {'type': 'answer_delta', 'text': '储能电量36.4%。'}
        yield {'type': 'done', 'mode': 'fallback'}
        return {'answer': '储能电量36.4%。'}
    monkeypatch.setattr(api, 'chat_events' if switch == '0' else 'agent_events', slow_tool_pipeline)
    request = api.ChatRequest(question='SOC', origin=load_replay('normal')['hours'][14]['t'])
    started = time.monotonic()
    events = [(time.monotonic()-started, event) for event in api.guarded_chat(request, api.chat_provider())]
    first = next(i for i, (_, e) in enumerate(events) if e['type'] == 'answer_delta')
    ticks = [(t, e) for t, e in events[:first] if e['type'] == 'progress']
    assert [e['elapsed_seconds'] for _, e in ticks] == [1, 2, 3]
    assert {e['id'] for _, e in ticks} == {'chat-answer-wait'}
    assert [e['text'] for _, e in ticks] == ['已等待 1 秒', '已等待 2 秒', '已等待 3 秒']
    assert all(abs(t - n) < .35 for n, (t, _) in enumerate(ticks, 1))
    assert not any(e['type'] == 'progress' for _, e in events[first:])


def test_inner_progress_deduplicated_and_return_value_preserved():
    def pipeline():
        yield {'type': 'progress', 'id': 'chat-answer-wait', 'text': 'inner'}
        yield {'type': 'answer_delta', 'text': 'ok'}
        return {'answer': 'ok'}
    g = progress_events(pipeline, object())
    assert next(g) == {'type': 'answer_delta', 'text': 'ok'}
    with pytest.raises(StopIteration) as e:
        next(g)
    assert e.value.value == {'answer': 'ok'}
