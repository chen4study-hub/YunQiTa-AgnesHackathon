import pytest
from src.agent import chat_engine, chat_router, chat_tools, general_chat, web_search
from src.data.replay_payload import load_replay


@pytest.mark.parametrize('question,expected', [
    ('当前能源怎么样', 'current_energy'),
    ('现在用电情况如何', 'energy_totals'),
    ('光伏现在发多少电', 'current_energy'),
])
def test_local_energy_never_calls_public_or_route(monkeypatch, question, expected):
    monkeypatch.setattr(chat_engine, 'get_llm_status', lambda: {'mode': 'real'})
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: pytest.fail('must not search'))
    class Provider:
        def chat_call(self, phase, payload, *a):
            assert phase == 'answer'  # deterministic selection, not select/route/general
            return {'result': {'answer': payload['grounded_reference']},
                    'llm': {'mode': 'real', 'reason': 'call_succeeded'}}
    data = load_replay('normal')
    result = chat_engine.consume(chat_router.route_events(question, data, data['hours'][14], Provider(),
                                  display_date='2026-10-13', display_time='14:00'))
    assert chat_router.building_reading_question(question)
    assert result['known'] and result['grounded']
    assert result['tool_trace'][0]['tool'] == expected
    assert '常识整理' not in result['answer'] and '公开资料' not in result['answer']
    if question == '光伏现在发多少电':
        assert '114.3 kW' in result['answer'] and 'kWh' not in result['answer']
    if question == '现在用电情况如何':
        assert 'kWh' in result['answer'] and '元' in result['answer']


@pytest.mark.parametrize('question', ['当前能源行业有什么新闻', '什么是能源', '介绍光伏发电原理'])
def test_fast_path_does_not_swallow_public_knowledge(question):
    assert not chat_tools.local_current_energy(question)


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('raw', ['没查到相关资料。', '没有查到相关资料', '抱歉，没有找到公开信息。'])
def test_empty_public_reply_no_knowledge_prefix(monkeypatch, stream, raw):
    monkeypatch.setattr(web_search, 'search', lambda *a, **k: {'status': 'unavailable', 'sources': []})
    class Call:
        def chat_call(self, *a):
            return {'result': {'answer': raw}, 'llm': {'mode': 'real', 'reason': 'call_succeeded'}}
    class Stream:
        def chat_stream(self, *a):
            yield {'type': 'text_delta', 'text': raw}
            yield {'type': 'done', 'llm': {'mode': 'real', 'reason': 'call_succeeded'}}
    events = general_chat.events('搜索公开资料', Stream() if stream else Call(), web=True)
    deltas = []
    while True:
        try:
            event = next(events)
            if event['type'] == 'answer_delta': deltas.append(event['text'])
        except StopIteration as end:
            result = end.value
            break
    assert result['answer'] == '没查到相关资料。'
    assert ''.join(deltas) == result['answer']


def test_regression_has_three_operator_phrasings():
    import json
    from pathlib import Path
    cases = json.loads(Path('tests/building_chat_cases.json').read_text(encoding='utf-8'))
    for question in ('当前能源怎么样', '现在用电情况如何', '光伏现在发多少电'):
        assert sum(c['question'] == question for c in cases) == 1
