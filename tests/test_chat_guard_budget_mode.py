import time
import pytest
from src.agent import chat_topic_hook as hook, chat_engine, chat_sentence_stream
from src.data.replay_payload import load_replay


def test_classification_passes_twenty_and_waits_beyond_old_eight(monkeypatch):
    seen = []
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda *a: False)
    # Scale 20s to .2s; provider takes .1s, beyond scaled former 8s (.08s).
    monkeypatch.setattr(hook, 'CLASSIFICATION_SECONDS', .2)
    def classify(q, h, p, *, timeout_seconds):
        seen.append(timeout_seconds)
        time.sleep(.1)
        return {'category': 'none', 'reason': 'safe'}
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', classify)
    start = time.monotonic()
    events = hook.guarded_events('x', [], 's', lambda: iter([
        {'type': 'tool_start', 'tool': 'current_energy'},
        {'type': 'answer_delta', 'text': 'safe'}, {'type': 'done'}]), object())
    assert next(events)['type'] == 'tool_start'
    assert time.monotonic() - start < .08
    assert next(events)['text'] == 'safe'
    assert time.monotonic() - start >= .09
    assert not list(events)[-1]['terminated'] and seen == [.2]
    assert 20. == hook.guarded_events.__globals__['topic_guard'].MAX_TIMEOUT_SECONDS


def test_public_hook_uses_twenty_budget(monkeypatch):
    seen = []
    def classify(q, h, p, *, timeout_seconds):
        seen.append(timeout_seconds)
        return {'category': 'none', 'reason': 'safe'}
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda *a: False)
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', classify)
    list(hook.guarded_events('x', [], 's', lambda: iter([{'type': 'done'}]), object()))
    assert seen == [20.]


@pytest.mark.parametrize('timeout', [False, True])
def test_done_and_json_mode_tracks_composition_not_real_config(monkeypatch, timeout):
    monkeypatch.setattr(chat_engine, 'get_llm_status', lambda: {'mode': 'real'})
    monkeypatch.setattr(chat_sentence_stream, 'FIRST_TOKEN_SECONDS', .02)
    class Provider:
        def chat_stream(self, payload):
            if timeout:
                time.sleep(.05)
            yield {'type': 'text_delta', 'text': '当前光伏功率 114.3 kW，电网功率 820.1 kW，储能功率 323.7 kW。'}
            yield {'type': 'done', 'llm': {'mode': 'real', 'reason': 'call_succeeded'}}
        def cancel_chat(self): pass
    data = load_replay('normal')
    g = chat_engine.events('当前能源怎么样', data, data['hours'][14], Provider())
    observed = []
    while True:
        try: observed.append(next(g))
        except StopIteration as end:
            result = end.value
            break
    expected = 'fallback' if timeout else 'llm'
    assert observed[-1]['mode'] == result['mode'] == expected
    assert result['known'] and '114.3 kW' in result['answer']
    if timeout:
        assert result['explanation_source'] == 'template'
        assert observed[-1]['llm_reason'] == 'chat_first_token_timeout'
        time.sleep(.06)  # allow this fake worker to exit before the next test
