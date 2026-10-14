# 72f8c2b: chat readings display one decimal; raw humidity remains unchanged.
from src.data.replay_payload import load_replay
import copy,json,re
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.chat import answer
from src.agent.display_text import wording_text,render_public_fields
from src.agent.chat_evidence import compact_evidence


def fixture():
    d=load_replay('normal');row=d['hours'][14]
    row['weather']['outdoor_temp_c']=13.3;row['weather']['relative_humidity_pct']=57.2
    return d,row


@pytest.mark.parametrize('text,want',[
    ('这些候选数字对应 24 小时调度窗口，预测值节费。',''),
    ('这些候选数字对应 24 小时调度窗口，不是实测节费。',''),
    ('调度已经通过门控。非实测收益。需人工核对拒绝时段。','调度已经可自动调度。请值班人员检查拒绝时段的表计和设备记录。'),
    ('储能留电，预测计算结果预测值。','储能留电。'),
    ('储能留电，预测计算、预测值，等值班人员复核后使用。','储能留电。'),
    ('费用 263.4 元。该情景估计并非实测数据。','费用 263.4 元。'),
    ('现在 15:01。 当前室外 13.3 °C，湿度 57%。','现在 15:01。当前室外 13.3 °C，湿度 57%。'),
    ('仅比较接受时段，拒绝小时不计费用。','仅比较计入时段，拒绝小时不计费用。'),
    ('BA/EMS日志回执，不是实物设备执行确认。','BA/EMS 日志回执。'),
])
def test_delete_disclaimer_not_word_replace(text,want):
    assert wording_text(text)==want
    assert wording_text(want)==want


@pytest.mark.parametrize('mode',['demo','real'])
def test_current_weather_integer_host_evidence_and_no_range(monkeypatch,mode):
    d,row=fixture();before=copy.deepcopy(d)
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':v={'tool':'get_weather','setpoint_c':None}
            else:
                h=payload['tools']['tools'][0]['result']['hours'][0]
                assert h['humidity_percent']==57 and 'relative_humidity_pct' not in h
                v={'answer':payload['grounded_reference']}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'replay_hour',lambda *a:(d,row))
    c=TestClient(api.app);q={'question':'现在几点、天气怎么样？','origin':row['t'],'display_time':'15:01'}
    r=c.post('/chat',json=q).json()
    assert r['answer']=='现在 15:01。当前室外 13.3 °C，湿度 57.0%。'
    assert r['grounded'] and r['known']
    assert r['tool_trace'][-1]['result']['scope']=='current'
    assert r['tool_trace'][-1]['result']['hours'][0]['relative_humidity_pct']==57.2
    assert d==before
    events=[json.loads(l[6:]) for l in c.post('/chat/stream',json=q).text.splitlines() if l.startswith('data: ')]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==r['answer']
    assert [e['tool'] for e in events if e['type']=='tool_start']==['get_time','get_weather']


def test_future_weather_each_hour_and_missing_humidity(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    for p in row['forecast_24h'][:3]:p['weather']['outdoor_temp_c']=15.;p['weather']['relative_humidity_pct']=47.4
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Route:
        def chat_call(self,phase,payload,feedback=''):
            return {'result':{'choices':[{'tool':'get_weather','parameters':{}}]},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('未来几小时天气怎么样',d,row,Route())
    assert r['answer']=='15:00：室外 15.0 °C，湿度 47.0%。16:00：室外 15.0 °C，湿度 47.0%。17:00：室外 15.0 °C，湿度 47.0%。'
    assert r['tool_trace'][0]['result']['scope']=='future_hours'
    row['weather']['relative_humidity_pct']=None
    r=answer('天气怎么样',d,row)
    assert r['known'] and '湿度记录缺失' in r['answer'] and '57%' not in r['answer']


def test_llm_cannot_use_old_fractional_humidity_or_current_time_range(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Bad:
        calls=0
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':v={'tool':'get_weather','setpoint_c':None}
            else:
                self.calls+=1
                v={'answer':'今天 14:00–今天 17:00：室外 13.3 °C，湿度 57.2%。'} if self.calls==1 else {'answer':payload['grounded_reference']}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    p=Bad();r=answer('天气怎么样',d,row,p)
    assert p.calls==0 and not r['llm_called'] and r['explanation_source']=='template'
    assert r['answer']=='当前室外 13.3 °C，湿度 57.0%。'
