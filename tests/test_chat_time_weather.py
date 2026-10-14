from src.data.replay_payload import load_replay
import json
from pathlib import Path
from src.agent.chat import answer
from src.agent.chat_tools import intent
from src.agent import chat_engine
from scripts.export_weather_context import humidity


def test_time_weather_tools_and_events(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    d=load_replay('normal');row=d['hours'][12]
    assert intent('现在几点')[0]=='get_time' and intent('天气怎么样')[0]=='get_weather'
    for q,tool in [('现在几点','get_time'),('天气怎么样','get_weather')]:
        events=list(chat_engine.events(q,d,row,display_date='2026-10-12'))
        assert next(e for e in events if e['type']=='tool_start')['tool']==tool
        out=answer(q,d,row,display_date='2026-10-12');assert out['known'] and out['grounded']
        assert out['tool_trace'][0]['tool']==tool
    out=answer('今天日期是多少',d,row,display_date='2026-10-12')
    assert out['answer']=='今天是 10 月 12 日。'
    assert '2026-10-12' not in answer('现在几点',d,row,display_date='2026-10-12')['answer']
    assert humidity(20,20)==100 and humidity(20,float('nan')) is None
    out=answer('天气怎么样',d,row)
    assert '室外' in out['answer'] and '湿度' in out['answer']
    assert not any(w in out['answer'] for w in ('非实测','推算','沿用'))
    row.pop('weather');out=answer('天气怎么样',d,row)
    assert '湿度记录缺失' in out['answer']
