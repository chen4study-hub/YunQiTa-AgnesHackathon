import json
import httpx
from src.agent import topic_provider as mod
from src.agent import topic_guard


def test_classification_system_prompt_and_schema_only(monkeypatch):
    monkeypatch.setenv('LLM_MODE','real')
    monkeypatch.setenv('LLM_API_KEY','test-only-secret')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1')
    monkeypatch.setenv('LLM_MODEL','test')
    seen=[]
    def handle(request):
        payload=json.loads(request.content);seen.append(payload)
        assert payload['messages'][0]['role']=='system'
        assert payload['messages'][0]['content'] == topic_guard._INSTRUCTION
        assert not any('友好的中文助手' in m['content'] for m in payload['messages'])
        assert payload['tool_choice']['function']['name']=='classify_topic'
        return httpx.Response(200,json={'choices':[{'message':{'tool_calls':[{'function':{'name':'classify_topic','arguments':json.dumps({'category':'none','reason':'楼宇能源'})}}]}}]})
    real=httpx.Client
    monkeypatch.setattr(mod.httpx,'Client',lambda **kw:real(transport=httpx.MockTransport(handle),**kw))
    result=topic_guard.classify_topic('当前能源怎么样',[],mod.TopicClassificationProvider())
    assert result['category']=='none' and len(seen)==1


def test_failure_never_exposes_secrets_or_body(monkeypatch):
    monkeypatch.setenv('LLM_MODE','real');monkeypatch.setenv('LLM_API_KEY','test-only-secret')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','test')
    def handle(request):return httpx.Response(500,text='test-only-secret raw private body')
    real=httpx.Client
    monkeypatch.setattr(mod.httpx,'Client',lambda **kw:real(transport=httpx.MockTransport(handle),**kw))
    result=topic_guard.classify_topic('今天有哪些社会新闻',[],mod.TopicClassificationProvider())
    assert result['category']=='current_affairs'
    assert 'secret' not in str(result) and 'private body' not in str(result)


def test_transport_keeps_owner_budget_and_timeout_retry_signal(monkeypatch):
    import pytest
    monkeypatch.setenv('LLM_MODE','real');monkeypatch.setenv('LLM_API_KEY','test-only-secret')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','test')
    seconds=[]
    class Client:
        def __init__(self, **kw):seconds.append(kw['timeout'].read)
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def post(self,*a,**kw):raise httpx.ReadTimeout('not logged')
    monkeypatch.setattr(mod.httpx,'Client',Client)
    messages=[{'role':'system','content':'classify'}]
    tools=[{'function':{'name':'classify_topic'}}]
    with pytest.raises(httpx.ReadTimeout):
        list(mod.TopicClassificationProvider().agent_stream(messages,tools,12.))
    assert seconds==[12.]
