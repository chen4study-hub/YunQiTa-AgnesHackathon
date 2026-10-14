import json
import logging
import pytest
from fastapi.testclient import TestClient
from src.agent import provider as p
from src.agent.scheduler import DEFAULT,rule_plan
from src.api.app import app

FORECAST={'building_id':'A','model_version':'test','predictions':[{
    'timestamp':'2017-07-20T12:00:00Z','abstain':False,'abstain_reason':None,'point':100.,'lower':90.,'upper':110.}]}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ('LLM_MODE','LLM_API_KEY','LLM_API_KEY_FILE','LLM_BASE_URL','LLM_MODEL','LLM_TIMEOUT_SECONDS'):
        monkeypatch.delenv(name,raising=False)


def test_mock_is_fixed_offline_and_default_missing_key(monkeypatch):
    def forbidden(*args,**kwargs):raise AssertionError('mock must not open a client')
    monkeypatch.setattr(p.httpx,'Client',forbidden)
    assert p.get_llm_status()=={'mode':'demo','reason':'missing_key'}
    a=p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    assert a==p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    assert a['plan'][0]['battery_kw']==0
    monkeypatch.setenv('LLM_MODE','mock');monkeypatch.setenv('LLM_API_KEY','private-token-for-test')
    assert p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)['llm']['reason']=='explicit_mock'


def test_real_missing_key_warns_without_secrets(monkeypatch,caplog):
    monkeypatch.setenv('LLM_MODE','real')
    with caplog.at_level(logging.WARNING):status=p.get_llm_status()
    assert status=={'mode':'demo','reason':'missing_key'}
    assert 'using demo' in caplog.text


def test_real_call_base_url_timeout_and_redaction(monkeypatch):
    secret='private-token-for-test';monkeypatch.setenv('LLM_API_KEY',secret)
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1/');monkeypatch.setenv('LLM_MODEL','test-model')
    calls=[]
    plan=p.mock_proposal(FORECAST,DEFAULT,'unused')['plan'];plan[0]['reason']=secret
    class Response:
        def raise_for_status(self):pass
        def json(self):return {'choices':[{'message':{'tool_calls':[{'function':{'name':'propose_plan','arguments':json.dumps({'plan':plan})}}]}}]}
    class Client:
        def __init__(self,timeout):assert timeout==30
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,url,headers,json):
            calls.append(url);assert headers['Authorization']=='Bearer '+secret
            assert json['model']=='test-model';return Response()
    monkeypatch.setattr(p.httpx,'Client',Client)
    result=p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    assert calls==['https://example.test/v1/chat/completions']
    assert result['llm']=={'mode':'real','reason':'call_succeeded'}
    assert secret not in json.dumps(result)
    with TestClient(app) as client:status=client.get('/health').json()['llm']
    assert status=={'mode':'real','reason':'configuration_complete'}


def test_single_failure_falls_back_and_next_request_retries(monkeypatch,caplog,tmp_path):
    secret='private-token-for-test';monkeypatch.setenv('LLM_API_KEY',secret)
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','test-model')
    attempts=[]
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):attempts.append(1);raise RuntimeError(secret)
    monkeypatch.setattr(p.httpx,'Client',Client)
    from src.agent import scheduler
    records=[];monkeypatch.setattr(scheduler,'dispatch',lambda r:records.append(r))
    with caplog.at_level(logging.WARNING):
        for _ in range(2):
            result=rule_plan(FORECAST,provider=p.OpenAICompatibleProvider())
            assert result['llm']=={'mode':'mock','reason':'call_failed'}
    assert len(attempts)==2 and p.get_llm_status()['mode']=='real'
    assert secret not in caplog.text+json.dumps(result)+json.dumps(records)


def test_missing_dotenv_is_normal(tmp_path):
    assert p.load_dotenv(tmp_path/'missing.env',override=False) is False


def test_abstention_never_calls_network(monkeypatch):
    monkeypatch.setenv('LLM_API_KEY','private-token-for-test')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','test-model')
    monkeypatch.setattr(p.httpx,'Client',lambda **k:pytest.fail('abstention must be offline'))
    f={**FORECAST,'predictions':[{**FORECAST['predictions'][0],'abstain':True}]}
    assert p.OpenAICompatibleProvider().propose(f,DEFAULT)['llm']['reason']=='abstained_forecast'


def test_demo_with_complete_config_never_reads_key_file_or_network(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setenv('LLM_API_KEY','private-token-for-test')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','agnes-model')
    monkeypatch.setattr(p,'read_key',lambda:pytest.fail('demo should not even read a secret'))
    monkeypatch.setattr(p.httpx,'Client',lambda **k:pytest.fail('demo must be offline'))
    assert p.get_llm_status()=={'mode':'demo','reason':'explicit_demo'}
    a=p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    assert a==p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    assert a['llm']['mode']=='demo'


def test_partial_configuration_defaults_demo_and_has_no_vendor_defaults(monkeypatch):
    monkeypatch.setenv('LLM_API_KEY','private-token-for-test')
    assert p.get_llm_status()=={'mode':'demo','reason':'incomplete_configuration'}
    client=p.OpenAICompatibleProvider()
    assert client.endpoint=='' and client.model==''


def test_key_file_real_transport_and_secret_safe_failure(monkeypatch,tmp_path,caplog):
    secret='file-only-private-token';path=tmp_path/'provider.key';path.write_text(secret+'\n',encoding='utf-8')
    monkeypatch.setenv('LLM_API_KEY_FILE',str(path));monkeypatch.setenv('LLM_MODE','real')
    monkeypatch.setenv('LLM_BASE_URL','https://example.test/v1');monkeypatch.setenv('LLM_MODEL','agnes-model')
    seen=[]
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):
            assert kwargs['headers']['Authorization']=='Bearer '+secret
            seen.append(True);raise RuntimeError(secret)
    monkeypatch.setattr(p.httpx,'Client',Client)
    with caplog.at_level(logging.WARNING):result=p.OpenAICompatibleProvider().propose(FORECAST,DEFAULT)
    with TestClient(app) as client:health=client.get('/health').json()
    assert seen and result['llm']['reason']=='call_failed'
    assert secret not in json.dumps(result)+json.dumps(health)+caplog.text
    path.unlink()
    with caplog.at_level(logging.WARNING):status=p.get_llm_status()
    assert status=={'mode':'demo','reason':'key_file_unavailable'}
    assert str(path) not in json.dumps(status)+caplog.text


def test_direct_key_precedes_key_file(monkeypatch,tmp_path):
    monkeypatch.setenv('LLM_API_KEY','direct-private-token')
    monkeypatch.setenv('LLM_API_KEY_FILE',str(tmp_path/'absent.key'))
    assert p.read_key()==('direct-private-token','available')
