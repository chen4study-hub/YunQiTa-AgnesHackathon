import threading
from src.agent import chat_topic_hook as hook


def test_already_terminated_does_not_start_agent(monkeypatch):
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: True)
    events = list(hook.guarded_events('x', [], 's', lambda: (_ for _ in ()).throw(AssertionError()), None))
    # c250ee2 distinguishes an already-ended session from a new topic refusal.
    assert events[-1]['terminated'] and events[-1]['answer'] == '会话已终止，请开启新会话。'


def test_parallel_tool_events_then_refusal_no_agent_answer(monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: False)
    def classify(*a, **kw):
        release.wait(1)
        return dict(category='politics', reason='test')
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', classify)
    marks = []
    monkeypatch.setattr(hook.topic_guard, 'mark_terminated', lambda *a: marks.append(a))
    def pipeline():
        yield dict(type='tool_call', id='a')
        release.set()
        yield dict(type='tool_result', id='a')
        yield dict(type='answer_delta', text='must discard')
        yield dict(type='done')
    events = list(hook.guarded_events('x', [], 's', pipeline, None))
    assert events[0]['type'] == 'tool_call'
    assert not any(e.get('text') == 'must discard' for e in events)
    assert events[-1]['terminated'] and marks


def test_none_retains_model_text(monkeypatch):
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: False)
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='safe'))
    events = list(hook.guarded_events('x', [], 's', lambda: iter([dict(type='answer_delta', text='original'), dict(type='done')]), None))
    assert events[0]['text'] == 'original' and not events[-1]['terminated']


def test_json_consumer_keeps_original_result_and_null_session(monkeypatch):
    from src.agent.chat_engine import consume
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: False)
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', lambda *a, **kw: dict(category='none', reason='safe'))
    def pipeline():
        yield dict(type='answer_delta', text='original')
        yield dict(type='done', known=True)
        return dict(answer='original', known=True, tool_trace=[{'tool': 'get_time'}])
    result=consume(hook.guarded_events('x', [], None, pipeline, None))
    assert result['answer']=='original' and result['tool_trace'][0]['tool']=='get_time'
    assert result['session_id'] is None and not result['terminated']


def test_guard_waits_before_first_answer_and_closes_on_hit(monkeypatch):
    release=threading.Event(); closed=[]
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: False)
    def classify(*a, **kw):
        release.wait(1)
        return dict(category='current_affairs', reason='test')
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', classify)
    monkeypatch.setattr(hook.topic_guard, 'mark_terminated', lambda *a: None)
    def pipeline():
        try:
            yield dict(type='tool_start', tool='web_search')
            yield dict(type='answer_delta', text='unsafe')
            release.set()
            yield dict(type='done')
        finally:closed.append(True)
    events=list(hook.guarded_events('x', [], 's', pipeline, None))
    assert not any(e['type']=='tool_start' for e in events) and events[-1]['category']=='current_affairs'
    assert closed and all(e.get('text')!='unsafe' for e in events)


def test_classification_exception_discards_answer(monkeypatch):
    monkeypatch.setattr(hook.topic_guard, 'is_terminated', lambda s: False)
    def fail(*a, **kw): raise ValueError('private details')
    monkeypatch.setattr(hook.topic_guard, 'classify_topic', fail)
    events=list(hook.guarded_events('x', [], 's', lambda: iter([dict(type='answer_delta',text='unsafe'),dict(type='done')]), None))
    assert [e['type'] for e in events]==['error','done']
    assert events[-1]['answer']=='' and 'private details' not in str(events)


def test_deadline_uses_owner_fallback_not_timeout_race(monkeypatch):
    from src.agent.chat_engine import consume
    release=threading.Event(); calls=[]
    monkeypatch.setattr(hook.topic_guard,'is_terminated',lambda s: False)
    def classify(q,h,p,**kw):
        assert kw['timeout_seconds']==20
        calls.append(p)
        if p is not None:release.wait(1)
        return dict(category='current_affairs',reason='fallback')
    monkeypatch.setattr(hook.topic_guard,'classify_topic',classify)
    monkeypatch.setattr(hook.topic_guard,'mark_terminated',lambda *a: None)
    times=iter([0.,21.])
    monkeypatch.setattr(hook.time,'monotonic',lambda: next(times,21.))
    result=consume(hook.guarded_events('社会新闻',[],'s',lambda:iter([dict(type='answer_delta',text='unsafe')]),object()))
    release.set()
    assert result['terminated'] and result['category']=='current_affairs' and None in calls
