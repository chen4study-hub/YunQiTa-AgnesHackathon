from src.data.replay_payload import load_replay
"""Origin-local remaining-day peaks and one authoritative replay SOC snapshot."""
import copy
import json
from pathlib import Path
from datetime import datetime,timedelta,timezone
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine,chat_tools
from src.agent.chat import answer
from src.agent.tools import get_context,replay_soc
from src.agent.orchestrator import run_agent as real_run_agent


def fixture(scenario='normal',hour=14):
    data=load_replay(scenario)
    return data,data['hours'][hour]


class UnknownChoice:
    def chat_call(self,phase,payload,feedback=''):
        return {'llm':{'mode':'real','reason':'call_succeeded'},'result':{'tool':'unknown','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']}}


@pytest.mark.parametrize('question',['今天哪个小时的预测负荷最高？','今日哪个小时负荷最大？','今天剩下的最高预测负荷是多少？','今天负荷最高在几点'])
@pytest.mark.parametrize('mode',['demo','real'])
def test_today_peak_routes_even_llm_unknown_and_never_uses_nextday(question,mode,monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    data,row=fixture();row['point_kw']=99999
    for p in row['forecast_24h']:
        p['point_kw']=9999 if p['t'][:10]!=row['t'][:10] else (500 if p['t'][11:13]=='19' else 100)
        p['abstain']=False
    out=answer(question,data,row,UnknownChoice())
    assert out['known'] and out['grounded'] and not out['needs_human']
    assert [x['tool'] for x in out['tool_trace']]==['get_forecast','forecast_peak']
    forecast=out['tool_trace'][0]['result']['predictions']
    assert len(forecast)==9 and all(datetime.fromisoformat(p['timestamp']).date()==datetime.fromisoformat(row['t']).date() for p in forecast)
    peak=out['tool_trace'][-1]['result'];assert peak['scope']=='today_remaining' and peak['hour']==19 and peak['peak_kw']==500
    assert '今天' in out['answer'] and '剩余' in out['answer'] and '次日' not in out['answer']


def test_origin_offset_midnight_and_end_of_day_no_substitute(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    data,row=fixture();origin=datetime.fromisoformat(row['t'])
    for p in row['forecast_24h']:
        t=datetime.fromisoformat(p['t']);p['t']=t.astimezone(timezone.utc).isoformat()
        p['point_kw']=2000 if t.date()!=origin.date() else (999 if t.hour==23 else 100);p['abstain']=False
    out=answer('今天哪个小时的预测负荷最高？',data,row)
    assert out['tool_trace'][-1]['result']['hour']==23 and out['tool_trace'][-1]['result']['peak_kw']==999
    tomorrow=answer('明天预测负荷最大在几点？',data,row)
    assert tomorrow['known'] and tomorrow['tool_trace'][-1]['result']['day_label']=='次日'
    assert '明天 00:00' in tomorrow['answer'] and '不代表' not in tomorrow['answer']
    data,row=fixture(hour=23);out=answer('今天哪个小时的预测负荷最高？',data,row)
    assert not out['known'] and not out['needs_human'] and [t['tool'] for t in out['tool_trace']]==['get_forecast']
    assert out['tool_trace'][0]['result']['predictions']==[]
    # Unscoped24h still includes tomorrow; no change to old question.
    assert answer('未来24小时最高负荷',data,row)['known']


def test_real_answer_preserves_remaining_date_scope(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Provider:
        def __init__(self,bad):self.bad=bad
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'forecast_peak','setpoint_c':None} if phase=='select' else {'answer':'今天峰值在次日15:00，1250.1kW。' if self.bad else payload['grounded_reference']}
            return {'llm':{'mode':'real','reason':'call_succeeded'},'result':result}
    data,row=fixture();question='今天哪个小时的预测负荷最高？'
    good=answer(question,data,row,Provider(False))
    assert good['known'] and good['answer_source']=='llm_tools' and '剩余' in good['answer']
    bad=answer(question,data,row,Provider(True))
    assert bad['known'] and bad['answer_source']=='deterministic_tools' and '次日' not in bad['answer']
    assert bad['llm']['reason']=='chat_grounding_failed'


def test_today_scope_refusal_only_peak_and_wire_events(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    data,row=fixture();monkeypatch.setattr(api,'replay_scenario',lambda name:data)
    client=TestClient(api.app);q={'origin':row['t'],'scenario':'normal','question':'今天哪个小时的预测负荷最高？'}
    out=client.post('/chat',json=q).json()
    assert out['known'] and out['tool_trace'][-1]['result']['hour']==15 and out['tool_trace'][-1]['result']['peak_kw']==1250.1
    events=[json.loads(l.removeprefix('data: ')) for l in client.post('/chat/stream',json=q).text.splitlines() if l]
    types=[e['type'] for e in events]
    # 72f8c2b: start at real tool; generic query narration is absent.
    assert events[0]['type']=='tool_start' and events[-1]['type']=='done'
    assert [e['tool'] for e in events if e['type']=='tool_start']==['get_forecast','forecast_peak']
    assert types.index('tool_start')<types.index('tool_end')<types.index('answer_delta')<types.index('done')
    row['forecast_24h'][0]['abstain']=True
    assert answer(q['question'],data,row)['needs_human']


@pytest.mark.parametrize('scenario',['normal','peak','abstain'])
def test_replay_all24_soc_chat_context_equal_to_energy_snapshot(scenario,monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    data,_=fixture(scenario);before=.5
    served=TestClient(api.app).get(f'/replay/{scenario}').json()
    from src.data.replay_payload import display_precision
    assert [r['storage'] for r in served['hours']]==display_precision([r['storage'] for r in data['hours']])
    for row in data['hours']:
        soc=row['storage']['soc'];assert soc==pytest.approx(before-row['storage']['power_kw']/2000,abs=1e-6);before=soc
        context=get_context(data['meta']['building_id'],row['t'],(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat(),data)['hours'][0]
        out=answer('现在储能SOC多少',data,row);current=out['tool_trace'][0]['result']
        assert current['soc']==context['storage_soc']==soc
        assert current['soc_percent']==round(soc*100,1) and context['storage_soc_source']==current['soc_source']=='replay.storage.soc'
        assert out['known'] and out['grounded']
    normal,_=fixture();expected=.5-sum(r['storage']['power_kw'] for r in normal['hours'][:15])/2000
    assert normal['hours'][14]['storage']['soc']==pytest.approx(expected,abs=1e-6)
    selected=next(c for c in normal['hours'][14]['agent']['candidates'] if c['candidate_id']==normal['hours'][14]['agent']['selected'])
    assert normal['hours'][14]['storage']['power_kw']==selected['plan'][0]['battery_kw']
    assert normal['hours'][14]['storage']['power_kw']>0  # current frozen plan discharges at this hour


def test_normal_evaluation_battery_diagnosis_uses_saved_evidence_only():
    records=[json.loads(l) for l in Path('experiments/agent_eval_v1_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    normal=sorted([r for r in records if r['date']=='2017-10-23'],key=lambda r:r['hour'])
    assert len(normal)==24 and all(r['result']['plan'][0]['battery_kw']==0 and r['soc_after']==.5 for r in normal)
    assert all(r['result']['plan'][0]['hvac_setpoint_c']==25.5 for r in normal)
    assert sum(r['economics']['cost'] for r in normal)==sum(r['economics']['hold25_cost'] for r in normal)
    for r in normal:
        if 10<=r['hour']<=19:
            assert r['forecast']['predictions'][0]['upper']-r['context']['hours'][0]['pv_kw']<r['constraints']['peak_target_kw']
    first=normal[0];candidates={c['candidate_id']:c for c in first['result']['candidates']}
    assert candidates['rule_full']['plan'][0]['battery_kw']==-100
    assert candidates['rule_hold']['objective_metrics']['upper_grid_peak_kw']<candidates['rule_full']['objective_metrics']['upper_grid_peak_kw']
    assert candidates['rule_hold']['objective_metrics']['energy_cost_cny']<candidates['rule_full']['objective_metrics']['energy_cost_cny']


def test_snapshot_is_not_previous_row_or_double_applied_power_and_schedule_uses_it(monkeypatch,tmp_path):
    data,row=fixture();data['hours'][13]['storage']['soc']=.775
    # A displayed end-of-hour snapshot is chat evidence, not a planning seed.
    row['storage']={'soc':.4,'power_kw':200};monkeypatch.setattr(api,'replay_scenario',lambda name:data)
    monkeypatch.setenv('LLM_MODE','demo');monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    monkeypatch.setattr(api,'run_agent',lambda *a,**k:pytest.fail('inconsistent export must fail before agent/dispatch'))
    monkeypatch.setattr(api,'ROOT',tmp_path)
    client=TestClient(api.app);req={'building_id':data['meta']['building_id'],'scenario':'normal','start':row['t'],'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    for endpoint in ['/schedule','/explain']:assert client.post(endpoint,json=req).status_code==422
    assert not (tmp_path/'logs/dispatch.jsonl').exists()
    out=client.post('/chat',json={'scenario':'normal','origin':row['t'],'question':'现在SOC多少'}).json()
    assert out['tool_trace'][0]['result']['soc_percent']==40 and '40.0' in out['answer']
    assert row['storage']=={'soc':.4,'power_kw':200}
    for value in [None,float('nan'),1.1,True]:
        with pytest.raises(ValueError):replay_soc({'storage':{'soc':value}})
