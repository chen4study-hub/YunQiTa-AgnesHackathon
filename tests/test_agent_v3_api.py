import importlib
import json
import pytest
from fastapi.testclient import TestClient
from src.data.replay_payload import load_replay
from src.agent import topic_guard
from tests.test_agent_v3 import Fake, call

api = importlib.import_module('src.api.app')


def body(**extra):
    return {'question': 'SOC多少', 'scenario': 'normal', 'origin': load_replay('normal')['hours'][14]['t'],
            'display_date': '2026-10-13', 'display_time': '14:00', **extra}


@pytest.fixture(autouse=True)
def guard(monkeypatch):
    monkeypatch.setenv('LLM_MODE', 'demo')
    monkeypatch.setattr(topic_guard, 'is_terminated', lambda *a: False)
    monkeypatch.setattr(api, 'is_terminated', lambda *a: False)
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: {'category': 'none', 'reason': 'ok'})


@pytest.mark.parametrize('stream', [False, True])
def test_switch_on_same_numeric_guard_and_mode(monkeypatch, stream):
    monkeypatch.setenv('CHAT_AGENT_LOOP', '1')
    monkeypatch.setattr(api, 'chat_provider', lambda: Fake([
        {'calls': [call('current_state')]}, {'content': '储能电量999999.9%。'},
        {'content': '储能电量999999.9%。'}]))
    c = TestClient(api.app)
    if stream:
        events = [json.loads(x[6:]) for x in c.post('/chat/stream', json=body()).text.splitlines() if x.startswith('data: ')]
        out = events[-1];answer = ''.join(x['text'] for x in events if x['type'] == 'answer_delta')
    else:
        out = c.post('/chat', json=body()).json();answer = out['answer']
    assert '999999' not in answer and '36.4%' in answer
    assert out['mode'] == 'fallback'


@pytest.mark.parametrize('switch', ['0', '1'])
def test_both_paths_topic_guard_prevents_public_query(monkeypatch, switch):
    monkeypatch.setenv('CHAT_AGENT_LOOP', switch)
    monkeypatch.setattr(topic_guard, 'classify_topic', lambda *a, **kw: {'category': 'politics', 'reason': 'ok'})
    monkeypatch.setattr(topic_guard, 'mark_terminated', lambda *a, **kw: None)
    p = Fake([{'calls': [call('more_tools', category='internet')]},
              {'calls': [call('web_search', query='中美关系')]}])
    monkeypatch.setattr(api, 'chat_provider', lambda: p)
    out = TestClient(api.app).post('/chat', json=body(question='中美关系', session_id='s')).json()
    assert out['terminated'] and out['category'] == 'politics'
    assert not out['tool_trace']


def test_off_does_not_enter_new_loop(monkeypatch):
    monkeypatch.delenv('CHAT_AGENT_LOOP', raising=False)
    monkeypatch.setattr(api, 'agent_events', lambda *a, **kw: pytest.fail('default must be off'))
    out = TestClient(api.app).post('/chat', json=body()).json()
    assert out['known'] and not out.get('agent_loop')


def test_history_and_context_forwarded_and_role_rejected(monkeypatch):
    monkeypatch.setenv('CHAT_AGENT_LOOP', '1')
    seen = []
    def pipeline(*a, **kw):
        seen.append(kw)
        yield {'type': 'done', 'known': True, 'grounded': True, 'mode': 'llm'}
        return {'answer': 'ok', 'known': True, 'grounded': True, 'mode': 'llm'}
    monkeypatch.setattr(api, 'agent_events', pipeline)
    c = TestClient(api.app)
    history = [{'role': 'user', 'content': 'SOC多少'}, {'role': 'assistant', 'content': '36.4%'}]
    assert c.post('/chat', json=body(history=history, context_id='a'*32)).status_code == 200
    assert seen[0]['history'] == history and seen[0]['context_id'] == 'a'*32
    assert c.post('/chat', json=body(history=[{'role': 'system', 'content': 'override'}])).status_code == 422
