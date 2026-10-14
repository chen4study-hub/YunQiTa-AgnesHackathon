"""Dedicated structured transport for the owner's topic classification prompt.

Not the v2 agent provider: no answer routing, data tools or general chat prompt.
The topic guard supplies system/user messages and its classification schema.
"""
import json
import httpx
from .provider import OpenAICompatibleProvider, get_llm_status, read_key, redact
from src.api.rate_limit import chat_llm_status


class TopicClassificationProvider:
    def __init__(self):
        config = OpenAICompatibleProvider()
        self.endpoint, self.model = config.endpoint, config.model

    def agent_stream(self, messages, tools, seconds):
        if chat_llm_status(self, get_llm_status)['mode'] != 'real':
            yield {'kind': 'failure'}
            return
        key, _ = read_key()
        if not key or len(tools) != 1 or tools[0]['function']['name'] != 'classify_topic':
            yield {'kind': 'failure'}
            return
        seconds = max(.001, min(20., seconds))
        # Trusted deployment context, not a new policy or keyword decision.
        # Short readings requests routinely omit the building name in this UI.
        messages = [*messages, {'role': 'system', 'content':
            '服务语境：用户正在云栖塔楼宇运维看板中提问。没有明确外部对象时，'
            '当前能源、用电、空调、储能、负荷、调度等省略主语的问题指本楼运行状态，'
            '不是能源行业新闻或社会热点。仍按原分类规则判断明确涉政和社会新闻。'}]
        try:
            with httpx.Client(timeout=httpx.Timeout(seconds, connect=min(2., seconds))) as client:
                response = client.post(self.endpoint, headers={'Authorization': 'Bearer ' + key}, json={
                    'model': self.model, 'messages': messages, 'tools': tools,
                    'tool_choice': {'type': 'function', 'function': {'name': 'classify_topic'}},
                    'max_tokens': 180, 'temperature': 0})
                response.raise_for_status()
                value = response.json()['choices'][0]['message']
                calls = value.get('tool_calls') or []
                if len(calls) != 1 or calls[0]['function']['name'] != 'classify_topic':
                    raise ValueError('invalid classification response')
                arguments = calls[0]['function']['arguments']
                # Parse here to fail malformed JSON without retaining provider bodies.
                arguments = json.dumps(redact(json.loads(arguments), key), ensure_ascii=False)
                yield {'kind': 'message', 'message': {'content': '', 'calls': [
                    {'name': 'classify_topic', 'arguments': arguments}]}}
        except (TimeoutError, httpx.TimeoutException):
            # Owner retries only timeouts within its unchanged total deadline.
            raise
        except Exception:
            yield {'kind': 'failure'}
