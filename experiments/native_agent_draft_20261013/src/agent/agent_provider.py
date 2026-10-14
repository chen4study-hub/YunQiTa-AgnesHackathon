"""Native OpenAI function-call streaming; no tool execution or body logging."""
import json
import time
import httpx
from .provider import OpenAICompatibleProvider, get_llm_status, read_key, redact


class AgentProvider(OpenAICompatibleProvider):
    def agent_stream(self, messages, tools, seconds):
        status = get_llm_status()
        key, _ = read_key()
        if status['mode'] != 'real' or not key:
            yield {'kind': 'failure', 'reason': 'provider_unavailable'}
            return
        deadline = time.monotonic() + seconds
        try:
            with httpx.Client(timeout=httpx.Timeout(seconds, connect=min(2., seconds))) as client:
                self._chat_client = client
                with client.stream('POST', self.endpoint,
                        headers={'Authorization': 'Bearer ' + key}, json={
                            'model': self.model, 'messages': messages,
                            'tools': tools, 'tool_choice': 'auto',
                            'stream': True, 'temperature': 0, 'max_tokens': 1800}) as response:
                    response.raise_for_status()
                    text = []
                    calls = {}
                    complete = False
                    seen = False
                    size = 0
                    for line in response.iter_lines():
                        if self._chat_cancel.is_set():
                            return
                        if time.monotonic() >= deadline:
                            raise TimeoutError()
                        if not line.startswith('data:'):
                            continue
                        raw = line[5:].strip()
                        if raw == '[DONE]':
                            break
                        choices = json.loads(raw).get('choices', [])
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get('delta', {})
                        if delta.get('refusal'):
                            raise ValueError()
                        content = delta.get('content') or ''
                        fragments = delta.get('tool_calls') or []
                        if (content or fragments) and not seen:
                            seen = True
                            yield {'kind': 'first_token'}
                        size += len(content) + len(json.dumps(fragments))
                        if size > 32000:
                            raise ValueError()
                        text.append(content)
                        for fragment in fragments:
                            index = fragment['index']
                            if not isinstance(index, int) or not 0 <= index < 8:
                                raise ValueError()
                            call = calls.setdefault(index, {'name': '', 'arguments': ''})
                            function = fragment.get('function', {})
                            call['name'] += function.get('name', '')
                            call['arguments'] += function.get('arguments', '')
                        finish = choice.get('finish_reason')
                        if finish in ('stop', 'tool_calls'):
                            complete = True
                        elif finish:
                            raise ValueError()
                    if not complete:
                        raise ValueError()
                    yield {'kind': 'message', 'message': redact({
                        'role': 'assistant', 'content': ''.join(text),
                        'calls': [calls[i] for i in sorted(calls)]}, key)}
        except Exception:
            # Never include response bodies, credentials or exception messages.
            yield {'kind': 'failure', 'reason': 'provider_failed'}
