from tests.test_frozen_economics import historical_economics
from src.data.replay_payload import load_replay
import json,subprocess
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.selection import policy_order,misleading_tradeoff
from src.agent.orchestrator import check_grounding,rounded_tools,candidate_evidence
from src.agent.display_text import display_evidence
from scripts.report_peak_tolerance import report
from scripts.evaluate_agent13 import current_economics
from src.agent.tools import check_constraints


def test_frozen312_v4_safety_objective_economics_and_daily_sources():
    rows=[json.loads(l) for l in Path('experiments/agent_eval_v4_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    summary=json.loads(Path('experiments/agent_eval_v4_summary.json').read_text())
    assert len(rows)==len({(r['date'],r['hour']) for r in rows})==312
    assert report(rows)==summary['summary']
    for date in {r['date'] for r in rows}:
        selected=sorted([r for r in rows if r['date']==date],key=lambda r:r['hour']);soc=.5
        daily=next(d for d in summary['days'] if d['date']==date)
        assert sum(daily['wording_categories'].values())==24
        assert daily['wording_categories']==report(selected)['wording_categories']
        for r in selected:
            a=r['result'];ordered,minimum,tolerance=policy_order(a['candidates'])
            assert ordered[0]['candidate_id']==a['selected']
            assert r['soc_before']==pytest.approx(soc)
            soc-=a['plan'][0]['battery_kw']/r['constraints']['battery_capacity_kwh']
            assert r['soc_after']==pytest.approx(soc)
            assert not check_constraints(a['plan'],r['constraints'])
            assert historical_economics(a['plan'][0],r['forecast'],r['context'],r['constraints'])==r['economics']
            assert check_grounding(a['reason'],display_evidence({'forecast':rounded_tools(r['forecast']),'candidates':candidate_evidence(a['candidates'])},r['forecast']['predictions'][0]['timestamp']))
            assert not misleading_tradeoff(a['reason'],a['selection_reason'])
            assert all(p['battery_kw']==0 for p,f in zip(a['plan'],r['forecast']['predictions']) if f['abstain'])
            if r['current_refused']:assert not r['provider_attempts'] and a['receipt']['count']==0
            else:assert r['provider_attempts'] and a['receipt']['count']==2
    assert summary['summary']['explanation_unsourced_numeric_token_count']==0
    assert summary['comparison_to_v3']['forecast_changed_hours']==0


def test_three_exports_new_policy_controls_and_no_zero_purchase():
    for name in ['normal','peak','abstain']:
        d=json.loads(subprocess.check_output(['git','show',f'bda65cb:exports/replay/{name}.json']).decode('utf-8'));soc=.5
        previous=json.loads(subprocess.check_output(['git','show',f'c28a18e:exports/replay/{name}.json']).decode('utf-8'))
        for row,old in zip(d['hours'],previous['hours']):
            assert {k:v for k,v in row.items() if k not in ('agent','storage','grid_kw')}=={k:v for k,v in old.items() if k not in ('agent','storage','grid_kw')}
            a=row['agent'];assert a['selection_reason']['policy']['id']=='upper_grid_peak_tolerance_then_cost_v2'
            assert not misleading_tradeoff(a['explanation'],a['selection_reason'])
            soc-=row['storage']['power_kw']/2000
            assert row['storage']['soc']==pytest.approx(soc,abs=1e-6)
        if name=='normal':
            a=d['hours'][14]['agent'];assert a['selected']=='rule_full' and a['selection_reason']['additional_cost_cny']==0


@pytest.mark.parametrize('mode',['demo','real'])
def test_normal14_chat_and_sse_no_paid_zero_peak(monkeypatch,mode):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Bad:
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'selection_reason','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']+'多花0.0元换减少0.0千瓦。'}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Bad)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Bad)
    data=load_replay('normal');row=data['hours'][14]
    request={'scenario':'normal','origin':row['t'],'question':'为什么这样调度？'};client=TestClient(api.app)
    out=client.post('/chat',json=request).json();assert out['known'] and out['grounded']
    assert '电费' in out['answer'] and '多花' not in out['answer']
    assert not any(w in out['answer'] for w in ('容差','微差','首步','重规划'))
    assert out['explanation_source']==('llm' if mode=='real' else 'template')
    if mode=='real':assert out['llm']['prose_repair']['dropped_sentences']==1
    response=client.post('/chat/stream',json=request)
    events=[json.loads(l.removeprefix('data: ')) for l in response.text.splitlines() if l]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    assert events[-1]['explanation_source']==out['explanation_source']
