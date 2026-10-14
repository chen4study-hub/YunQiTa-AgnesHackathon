"""Native function-call transport with separate first-delta and request deadlines."""
import json
import threading
import time
import httpx
from .provider import OpenAICompatibleProvider, get_llm_status, read_key, redact
from src.api.rate_limit import chat_llm_status


class AgentProvider(OpenAICompatibleProvider):
    def __init__(self, model=None):
        super().__init__()
        if model is not None:
            self.model = model
        self.metrics = []
        self._request_stop = None

    def cancel_request(self):
        stop = self._request_stop
        if stop is not None:
            stop.set()
        client = getattr(self, '_chat_client', None)
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    def cancel_chat(self):
        self._chat_cancel.set()
        self.cancel_request()

    def agent_stream(self, messages, tools, seconds, first_seconds=10.):
        start = time.monotonic()
        deadline = start + max(.001, seconds)
        first_deadline = min(deadline, start + first_seconds)
        metric = {'first_response_ms': None, 'total_ms': None, 'tool_count': len(tools),
                  'tools': [t['function']['name'] for t in tools], 'error': None,
                  'complete': False, 'output_chars': 0}
        self.metrics.append(metric)
        stop, done, seen = threading.Event(), threading.Event(), threading.Event()
        self._request_stop = stop
        key, _ = read_key()
        if chat_llm_status(self, get_llm_status)['mode'] != 'real' or not key:
            metric.update(error='provider_unavailable', total_ms=0.)
            yield {'kind': 'failure', 'reason': 'provider_unavailable'}
            return
        client = httpx.Client(timeout=httpx.Timeout(max(.001, seconds), connect=min(2., seconds)), trust_env=False)
        self._chat_client = client
        def watchdog():
            while not done.wait(.02):
                bound = deadline if seen.is_set() else first_deadline
                if stop.is_set() or self._chat_cancel.is_set() or time.monotonic() >= bound:
                    stop.set()
                    try:
                        client.close()
                    except Exception:
                        pass
                    return
        timer = threading.Thread(target=watchdog, daemon=True, name='agent-request-deadline')
        timer.start()
        text, calls, complete = [], {}, False
        try:
            with client.stream('POST', self.endpoint, headers={'Authorization': 'Bearer ' + key}, json={
                    'model': self.model, 'messages': messages, 'tools': tools,
                    'tool_choice': 'auto', 'stream': True, 'temperature': 0, 'max_tokens': 1400}) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    bound = deadline if seen.is_set() else first_deadline
                    if stop.is_set() or self._chat_cancel.is_set() or time.monotonic() >= bound:
                        raise TimeoutError()
                    if not line.startswith('data:'):
                        continue
                    raw = line[5:].strip()
                    if raw == '[DONE]':
                        break
                    choices = json.loads(raw).get('choices', [])
                    if not choices:
                        continue
                    if len(choices) != 1:
                        raise ValueError()
                    choice = choices[0]
                    delta = choice.get('delta') or {}
                    if delta.get('refusal'):
                        raise ValueError()
                    content, fragments = delta.get('content') or '', delta.get('tool_calls') or []
                    if (content or fragments) and not seen.is_set():
                        metric['first_response_ms'] = round((time.monotonic() - start) * 1000, 1)
                        seen.set()
                        yield {'kind': 'first_token'}
                    text.append(content)
                    metric['output_chars'] += len(content) + len(json.dumps(fragments))
                    if metric['output_chars'] > 32000:
                        raise ValueError()
                    for fragment in fragments:
                        index = fragment['index']
                        if not isinstance(index, int) or not 0 <= index < 8:
                            raise ValueError()
                        call = calls.setdefault(index, {'name': '', 'arguments': ''})
                        function = fragment.get('function') or {}
                        call['name'] += function.get('name', '')
                        call['arguments'] += function.get('arguments', '')
                    finish = choice.get('finish_reason')
                    if finish in ('stop', 'tool_calls'):
                        complete = True
                    elif finish:
                        raise ValueError()
                if not complete or not seen.is_set():
                    raise ValueError()
            metric['complete'] = True
            yield {'kind': 'message', 'message': redact({'content': ''.join(text),
                   'calls': [calls[i] for i in sorted(calls)]}, key)}
        except Exception as exc:
            timed = stop.is_set() or isinstance(exc, (TimeoutError, httpx.TimeoutException))
            reason = ('first_token_timeout' if not seen.is_set() else 'agent_deadline') if timed else 'provider_failed'
            if self._chat_cancel.is_set():
                reason = 'agent_cancelled'
            metric['error'] = reason
            if isinstance(exc, httpx.HTTPStatusError):
                metric['status_code'] = exc.response.status_code
            yield {'kind': 'failure', 'reason': reason}
        finally:
            done.set()
            client.close()
            timer.join(timeout=.2)
            self._request_stop = None
            self._chat_client = None
            metric['total_ms'] = round((time.monotonic() - start) * 1000, 1)
