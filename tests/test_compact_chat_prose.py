from src.data.replay_payload import load_replay
import json,re,copy
from datetime import datetime,timedelta
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.chat import answer
from src.agent.chat_evidence import compact_evidence,prompt_view
from src.agent.display_text import compact_time_text,render_public_fields,power_unit_text,PUBLIC_TEXT_FIELDS,BANNED_USER_WORDS
from src.agent.numeric_prompt import numeric_instruction


def fixture():
    d=load_replay('normal');return d,d['hours'][14]


@pytest.mark.parametrize('text,want',[
    ('为今天 10:00、今天 11:00、今天 12:00峰段留电','为10:00–12:00 峰段留电'),
    ('次日 10:00、次日 11:00、次日 12:00','次日 10:00–12:00'),
    ('今天 23:00、次日 00:00、次日 01:00','23:00、次日 00:00–01:00'),
    ('今天 10:00、今天 12:00','10:00、12:00'),
    ('今天 12:00、今天 11:00','12:00、11:00'),
    ('今天 10:15、今天 10:30','10:15、10:30'),
    ('次日 17:00（拒绝）；次日 18:00（拒绝）；次日 19:00（拒绝）','次日 17:00–19:00（拒绝）'),
    ('17:00（拒绝）、18:00（拒绝）、19:00（拒绝）','17:00–19:00（拒绝）'),
    ('14:00 到 16:00','14:00–16:00'),
    ('次日 14:00 至次日 16:00','次日 14:00–16:00'),
])
def test_time_compact_exact_and_idempotent(text,want):
    assert compact_time_text(text)==want
    assert compact_time_text(want)==want


@pytest.mark.parametrize('text,want',[
    ('电网负荷压至 1,082.4 至 1,095.3 kWh 区间','电网负荷压至 1,082.4 至 1,095.3 kW 区间'),
    ('用电量 1,082.4 kWh','用电量 1,082.4 kWh'),
    ('负荷功率 25.0 kWh，电量 25.0 kWh','负荷功率 25.0 kW，电量 25.0 kWh'),
])
def test_power_vs_energy(text,want):assert power_unit_text(text)==want


def test_unit_numeric_prompt_and_display_fields_only():
    prompt=numeric_instruction({'load_kw':12.,'grid_kw':11.,'load_kwh':12.,'grid_kwh':11.})
    assert '负荷功率(kW)' in prompt and '负荷电量' not in prompt and 'kWh' not in prompt
    d={'reason':'今天 10:00、今天 11:00负荷 11.0 kWh。非实测，推算，沿用。','timestamp':'2017-10-23T14:00:00-05:00','candidate_id':'rule_full'}
    r=render_public_fields(d)
    assert r['timestamp']==d['timestamp'] and r['candidate_id']==d['candidate_id']
    assert '10:00–11:00' in r['reason'] and '11.0 kW' in r['reason']
    assert not any(w in r['reason'] for w in BANNED_USER_WORDS)


@pytest.mark.parametrize('question',['现在几点、天气怎么样？','现在几点天气怎么样？'])
@pytest.mark.parametrize('mode',['demo','real'])
def test_multi_intent_time_weather_two_tools_and_host_clock(monkeypatch,mode,question):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            v={'tool':'get_weather','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    c=TestClient(api.app);q={'question':question,'origin':row['t'],'display_date':'2026-10-12','display_time':'13:44'}
    r=c.post('/chat',json=q).json()
    assert [t['tool'] for t in r['tool_trace']]==['get_time','get_weather']
    assert '现在 13:44' in r['answer'] and '室外' in r['answer'] and '湿度' in r['answer']
    events=[json.loads(l[6:]) for l in c.post('/chat/stream',json=q).text.splitlines() if l.startswith('data: ')]
    assert [e['tool'] for e in events if e['type']=='tool_start']==['get_time','get_weather']
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==r['answer']
    for text in [r['answer']]+[e.get('summary',e.get('text','')) for e in events if e['type']!='answer_delta']:
        assert not any(w in text for w in ('推算','非实测','沿用','不是独立天气预报','等值班人员复核后使用'))
    for question in ['今天几号','今天日期是多少']:
        assert c.post('/chat',json={**q,'question':question}).json()['answer']=='今天是 10 月 12 日。'


@pytest.mark.parametrize('bad',['24:00','13:60','3:44','13:44:00',1344])
def test_display_time_invalid_before_tool(monkeypatch,bad):
    _,row=fixture();monkeypatch.setattr(api,'tool_answer',lambda *a,**k:pytest.fail('must not execute'))
    c=TestClient(api.app)
    for endpoint in ['/chat','/chat/stream']:
        assert c.post(endpoint,json={'question':'现在几点','origin':row['t'],'display_time':bad}).status_code==422


def test_request_unknown_fields_ignored_known_values_still_validated(monkeypatch):
    _,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    c=TestClient(api.app)
    q={'question':'现在几点','origin':row['t'],'display_time':'13:44','future_frontend_field':'ignored'}
    for endpoint in ['/chat','/chat/stream']:assert c.post(endpoint,json=q).status_code==200
    assert c.post('/chat',json={**q,'display_time':'24:00'}).status_code==422
    assert api.Window.model_validate({'building_id':'test','start':row['t'],'end':datetime.fromisoformat(row['t'])+timedelta(hours=1),'future_field':True}).building_id=='test'


def test_required_values_rewrite_explicit_and_receipt_baems_allowed(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        calls=0
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':v={'tool':'execution_receipt','setpoint_c':None}
            else:
                self.calls+=1
                assert payload['required_answer_values'] and 'Required answer values' in payload['allowed_numeric_instruction']
                if self.calls==1:v={'answer':'BA/EMS下发日志回执已记录。'}
                else:
                    assert '回执指令条数' in feedback and '回执耗时' in feedback
                    v={'answer':payload['grounded_reference']}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    p=Fake();r=answer('执行回执是什么',d,row,p)
    assert r['explanation_source']=='llm' and 'BA/EMS' in r['answer'] and p.calls==2


@pytest.mark.parametrize('prefix',['','BA/EMS日志回执：'])
def test_false_physical_receipt_still_rejected(monkeypatch,prefix):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':v={'tool':'execution_receipt','setpoint_c':None}
            else:
                r=row['agent']['receipt'];v={'answer':prefix+f"设备执行完成 {r['count']} 条，耗时 {r['elapsed_ms']:.1f} 毫秒。"}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('执行回执是什么',d,row,Fake())
    assert r['explanation_source']=='template' and r['llm']['reason']=='chat_false_receipt'


def test_question_evidence_smaller_and_scope_kept():
    d,row=fixture();from src.agent.chat_tools import execute
    r=chat_engine.consume(execute('hvac_compare','空调改26度电费多少',d,row,26))
    e=compact_evidence(r['tool_trace']);assert [t['tool'] for t in e]==['compare_costs']
    assert 'excluded' in e[-1]['result'] and e[-1]['result']['before_cost'] is not None
    assert len(json.dumps(e))<len(json.dumps(r['tool_trace']))/3


def assert_visible_compact(obj,key=''):
    if isinstance(obj,dict):
        for k,v in obj.items():assert_visible_compact(v,k)
    elif isinstance(obj,list):
        for v in obj:assert_visible_compact(v,key)
    elif isinstance(obj,str) and key in PUBLIC_TEXT_FIELDS:
        assert not any(w in obj for w in BANNED_USER_WORDS)
        assert all(len(re.findall('今天|次日',s))<=2 for s in re.split(r'[。！？!?\n]',obj))
        assert not re.search(r'今天\s*\d{2}:\d{2}',obj)
        assert not any('kWh' in s and re.search('负荷|功率|峰值',s) and not re.search('电量|电耗|用电|耗电|能量',s) for s in re.split(r'[，。；！？]',obj))


@pytest.mark.parametrize('scenario',['normal','peak','abstain'])
def test_schedule_common_formatter_all_scenarios(monkeypatch,tmp_path,scenario):
    monkeypatch.setenv('LLM_MODE','demo');monkeypatch.setattr(api,'ROOT',tmp_path)
    d=load_replay(scenario);row=d['hours'][14]
    monkeypatch.setattr(api,'replay_hour',lambda *a:(d,row))
    r=TestClient(api.app).post('/schedule',json={'scenario':scenario,'building_id':d['meta']['building_id'],'start':row['t'],'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat(),'future_frontend_field':True})
    assert r.status_code==200;assert_visible_compact(r.json())


def test_all_current_replay_prose_clean():
    def texts(o,key=''):
        if isinstance(o,dict):
            for k,v in o.items():yield from texts(v,k)
        elif isinstance(o,list):
            for v in o:yield from texts(v,key)
        elif isinstance(o,str) and key in PUBLIC_TEXT_FIELDS:yield o
    for name in ['normal','peak','abstain']:
        for t in texts(load_replay(name)):
            assert not any(w in t for w in BANNED_USER_WORDS)
            assert all(len(re.findall('今天|次日',s))<=2 for s in re.split(r'[。！？!?\n]',t))
            assert not re.search(r'今天\s*\d{2}:\d{2}',t)
            assert not re.search(r'\d+\.0\s*(?:小时|条|个)',t)
