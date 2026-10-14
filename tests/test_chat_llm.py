from src.data.replay_payload import load_replay
import copy
import json
from pathlib import Path
import pytest
from src.agent import chat_engine as chat,provider
from src.agent.chat_engine import consume
from src.agent.chat import answer


@pytest.fixture
def real(monkeypatch):
    monkeypatch.setattr(chat,'get_llm_status',lambda:{'mode':'real','reason':'configuration_complete'})
    d=load_replay('normal');r=d['hours'][12]
    return d,r


def test_real_tool_selection_and_answer_grounding_retry(real):
    d,r=real
    class Fake:
        attempts=0
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':return {'result':{'tool':'forecast_peak','setpoint_c':None},'llm':{'mode':'real','reason':'call_succeeded'}}
            self.attempts+=1
            if self.attempts==1:text='峰值999999.9 kW。'
            else:
                assert 'No usable grounded sentences remain' in feedback
                text=payload['grounded_reference']
            return {'result':{'answer':text},'llm':{'mode':'real','reason':'call_succeeded'}}
    f=Fake();out=answer('未来负荷最大是什么时候？',d,r,f)
    assert f.attempts==2 and out['answer_source']=='llm_tools' and out['grounded'] and out['llm_mode']=='real'
    assert out['selected_tool']=='forecast_peak' and out['llm_called']
    assert out['explanation_source']=='llm'


def test_real_failure_or_invalid_tool_falls_back(real):
    d,r=real
    class Bad:
        def chat_call(self,*a):return {'result':{'tool':'execute_shell','setpoint_c':None},'llm':{'mode':'real','reason':'call_succeeded'}}
    out=answer('未来24小时峰值',d,r,Bad())
    assert out['answer_source']=='deterministic_tools' and out['llm_mode']=='rule' and out['grounded']
    assert out['explanation_source']=='template'
    class Failed:
        def chat_call(self,*a):return {'result':None,'llm':{'mode':'rule','reason':'call_failed','error_type':'ReadTimeout','status_code':None}}
    out=answer('未来24小时峰值',d,r,Failed())
    assert out['llm']['error_type']=='ReadTimeout' and out['answer_source']=='deterministic_tools'


def test_what_if_baseline_is_current_setpoint(real):
    d,r=real
    for p in r['forecast_24h']:p['abstain']=False
    r['agent']['hvac_setpoint_c']=25.5
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'hvac_compare','setpoint_c':26.} if phase=='select' else {'answer':payload['grounded_reference'].replace('在线性计算中','在线性情景中')+'该情景估计并非实测数据。'}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    out=answer('空调改26度',d,r,Fake());assert out['llm_mode']=='real' and out['grounded']
    evidence=next(t['result'] for t in out['tool_trace'] if t['tool']=='compare_costs')
    assert evidence['before_setpoint_c']==25.5 and evidence['after_setpoint_c']==26.
    assert '25.5' in out['answer'] and '预计' in out['answer'] and '非实测' not in out['answer']


def test_demo_uses_rules_without_provider_calls(monkeypatch):
    monkeypatch.setattr(chat,'get_llm_status',lambda:{'mode':'demo','reason':'missing_key'})
    d=load_replay('normal');r=d['hours'][12]
    class Never:
        def chat_call(self,*a):pytest.fail('demo must not call')
    out=answer('未来24小时峰值',d,r,Never())
    assert out['llm_mode']=='demo' and not out['llm_called']


def test_provider_chat_safe_timeout_metadata(monkeypatch,caplog):
    import httpx
    monkeypatch.setattr(provider,'get_llm_status',lambda:{'mode':'real','reason':'configuration_complete'})
    secret='not-a-real-credential'
    monkeypatch.setattr(provider,'read_key',lambda:(secret,'available'))
    class Client:
        def __init__(self,**kw):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def post(self,*a,**kw):raise httpx.ReadTimeout('unsafe echo '+secret)
    monkeypatch.setattr(provider.httpx,'Client',Client)
    out=provider.OpenAICompatibleProvider().chat_call('select',{'question':'峰值'})
    assert out['llm']['error_type']=='ReadTimeout' and secret not in str(out) and secret not in caplog.text
