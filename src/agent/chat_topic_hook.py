"""Parallel topic guard seam; shared by JSON and SSE chat."""
import queue
import threading
import time
import uuid
from . import topic_guard

CLASSIFICATION_SECONDS = 20.
_PENDING_LOCK = threading.Lock()
_PENDING = {}


def reserve_classification(state_id):
    """Atomically serialize same-session verdicts, not all chat requests."""
    while True:
        with _PENDING_LOCK:
            previous = _PENDING.get(state_id)
            if previous is None:
                ticket = threading.Event()
                _PENDING[state_id] = ticket
                return ticket
        # The prior worker sets this AFTER marking terminated and writing audit.
        # Independent response-level progress keeps this wait visible.
        previous.wait()


def release_classification(state_id, ticket):
    with _PENDING_LOCK:
        if _PENDING.get(state_id) is ticket:_PENDING.pop(state_id)
        ticket.set()


def termination(session_id, category, mode):
    text = '会话已终止，请开启新会话。' if category == 'terminated' else topic_guard.refusal_message()
    yield {'type': 'answer_delta', 'text': text, 'sentence_source': 'policy'}
    yield {'type': 'done', 'mode': mode, 'session_id': session_id,
           'known': False, 'grounded': True, 'needs_human': False,
           'reason': 'out_of_scope', 'terminated': True, 'category': category,
           'answer': text, 'explanation_source': 'policy', 'phase_timings': [],
           'llm_reason': 'topic_terminated', 'context_id': None}


def guarded_events(question, history, session_id, pipeline_factory, classification_provider, mode='llm'):
    """Factory delays agent start until terminated check; independent provider required.

    Tool events pass through while classification runs. Model/external answers wait
    for classification; a completed, proven pure-local reference may bypass while
    the classifier continues auditing and terminating sessions in its own thread.
    Missing IDs use an internal ephemeral state key; the response preserves null.
    """
    state_id = session_id or uuid.uuid4().hex
    ticket = reserve_classification(state_id)
    if topic_guard.is_terminated(state_id):
        release_classification(state_id, ticket)
        yield from termination(session_id, 'terminated', mode)
        return _refused(session_id, 'terminated', mode)
    box = queue.Queue(maxsize=1)
    started = time.monotonic()
    deadline = started + CLASSIFICATION_SECONDS
    diagnostics = {'budget_seconds': CLASSIFICATION_SECONDS}
    def annotate(event):
        event = _annotate(event, session_id)
        if event['type'] == 'done':event = {**event, 'classification_timing': dict(diagnostics)}
        return event
    def classify():
        try:
            verdict = topic_guard.classify_topic(question, history, classification_provider, timeout_seconds=CLASSIFICATION_SECONDS)
            if verdict and verdict['category'] != 'none':
                # Independent of the request generator lifetime: a pure local
                # answer may have completed while this classification was running.
                topic_guard.mark_terminated(state_id, verdict['category'], verdict['reason'], question)
            box.put(verdict)
        except Exception:
            box.put(None)
        finally:
            diagnostics['elapsed_ms'] = round((time.monotonic() - started) * 1000, 1)
            release_classification(state_id, ticket)
    threading.Thread(target=classify, daemon=True, name='chat-topic-hook').start()
    pipeline = pipeline_factory()
    decision = None
    ready = False
    pending = []
    pipeline_error = None
    external_used = False
    model_text = False
    try:
        result = {}
        while True:
            try:
                event = next(pipeline)
            except StopIteration as end:
                result = end.value or {}
                break
            except Exception as exc:
                pipeline_error = exc
                break
            if event.get('tool') in ('web_search', 'city_weather'):external_used = True
            if event.get('type') == 'answer_delta' and event.get('sentence_source') == 'llm':model_text = True
            if not ready and event.get('type') in ('tool_start','tool_call') and event.get('tool') in ('web_search','city_weather'):
                # A generator suspends at tool_start, before the actual request.
                # Do not advance it (or disclose its arguments) before approval.
                try:
                    decision=box.get(timeout=max(0.,deadline-time.monotonic()))
                except queue.Empty:
                    decision=topic_guard.classify_topic(question,history,None,timeout_seconds=CLASSIFICATION_SECONDS)
                ready=True
                if decision is None:
                    break
            if not ready:
                try:
                    decision = box.get_nowait()
                    ready = True
                except queue.Empty:
                    if time.monotonic() >= deadline:
                        decision = topic_guard.classify_topic(question, history, None, timeout_seconds=CLASSIFICATION_SECONDS)
                        ready = True
            if ready and decision and decision['category'] != 'none':
                topic_guard.mark_terminated(state_id, decision['category'], decision['reason'], question)
                yield from termination(session_id, decision['category'], mode)
                return _refused(session_id, decision['category'], mode)
            if ready and decision and decision['category'] == 'none':
                if 'answer_ready_ms' in diagnostics and 'answer_gate_wait_ms' not in diagnostics:
                    diagnostics['answer_gate_wait_ms'] = round(max(0., min((time.monotonic()-started)*1000, diagnostics.get('elapsed_ms', CLASSIFICATION_SECONDS*1000)) - diagnostics['answer_ready_ms']), 1)
                for held in pending:
                    yield annotate(held)
                pending.clear()
                yield annotate(event)
            elif event['type'] in ('answer_delta', 'done'):
                if event['type'] == 'answer_delta':
                    diagnostics.setdefault('answer_ready_ms', round((time.monotonic() - started) * 1000, 1))
                pending.append(event)
            else:
                yield event
        diagnostics['pipeline_ms'] = round((time.monotonic() - started) * 1000, 1)
        if not ready and pipeline_error is None and not external_used and not model_text and pure_local_answer(result):
            # Only after the whole pipeline completes can provenance be proven.
            # Never infer purity from the wording/question or the first tool.
            try:
                decision = box.get_nowait()
                ready = True
            except queue.Empty:
                diagnostics['answer_gate_wait_ms'] = 0.
                diagnostics['local_data_bypass'] = True
                for held in pending:
                    yield {**annotate(held), 'classification_pending': True} if held['type'] == 'done' else annotate(held)
                return {**result, 'session_id': session_id, 'terminated': False, 'category': 'none',
                        'classification_pending': True, 'classification_timing': dict(diagnostics)}
        if not ready:
            try:
                decision = box.get(timeout=max(0., deadline - time.monotonic()))
            except queue.Empty:
                # Both budgets expire at twenty seconds: obtain the owner's fast
                # conservative fallback rather than racing its queue publication.
                decision = topic_guard.classify_topic(question, history, None, timeout_seconds=CLASSIFICATION_SECONDS)
        if decision is None:
            yield {'type': 'error', 'code': 'topic_classification_unavailable', 'message': '本次回答未完成，请稍后再试。'}
            yield {'type': 'done', 'mode': mode, 'session_id': session_id, 'known': False,
                   'grounded': True, 'needs_human': False, 'reason': 'no_data',
                   'terminated': False, 'category': 'none', 'answer': ''}
            return {'answer': '', 'known': False, 'grounded': True, 'needs_human': False,
                    'reason': 'no_data', 'session_id': session_id, 'terminated': False, 'category': 'none', 'tool_trace': []}
        if decision['category'] != 'none':
            topic_guard.mark_terminated(state_id, decision['category'], decision['reason'], question)
            yield from termination(session_id, decision['category'], mode)
            return _refused(session_id, decision['category'], mode)
        if pipeline_error is not None:
            raise pipeline_error
        if 'answer_ready_ms' in diagnostics and 'answer_gate_wait_ms' not in diagnostics:
            diagnostics['answer_gate_wait_ms'] = round(max(0., min((time.monotonic()-started)*1000, diagnostics.get('elapsed_ms', CLASSIFICATION_SECONDS*1000)) - diagnostics['answer_ready_ms']), 1)
        for event in pending:
            yield annotate(event)
        return {**result, 'session_id': session_id, 'terminated': False, 'category': 'none',
                'classification_timing': dict(diagnostics)}
    finally:
        close = getattr(pipeline, 'close', None)
        if close:
            close()


def pure_local_answer(result):
    from .building_tools import NAMES
    local = set(NAMES) | {'get_time', 'get_weather', 'selection_reason', 'handoff_reason',
        'execution_receipt', 'current_state', 'current_energy', 'get_forecast', 'forecast_peak',
        'get_context_scenario', 'simulate_schedule_before', 'simulate_schedule_after', 'compare_costs'}
    trace = result.get('tool_trace') or []
    return bool(result.get('answer') and result.get('known') and result.get('grounded') and trace
                and result.get('explanation_source') == 'template'
                and result.get('answer_source') == 'deterministic_tools'
                and all(t.get('tool') in local for t in trace))


def _annotate(event, session_id):
    if event['type'] == 'done':
        return {**event, 'session_id': session_id, 'terminated': False, 'category': 'none'}
    return event


def _refused(session_id, category, mode):
    return {'answer': '会话已终止，请开启新会话。' if category == 'terminated' else topic_guard.refusal_message(), 'session_id': session_id,
            'known': False, 'grounded': True, 'needs_human': False, 'tool_trace': [],
            'reason': 'out_of_scope', 'terminated': True, 'category': category,
            'explanation_source': 'policy', 'llm_mode': mode, 'llm_called': False}
