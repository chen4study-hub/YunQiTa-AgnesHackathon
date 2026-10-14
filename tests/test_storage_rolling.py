from src.data.replay_payload import load_replay
import json,re
from pathlib import Path
import pytest
from src.agent.orchestrator import run_agent,candidate_evidence,check_grounding,reason_format_invalid
from src.agent.display_text import display_evidence
from src.agent.rolling_context import from_replay
from src.agent.tools import check_constraints


def inputs(name='normal',hour=14):
    data=load_replay(name)
    return from_replay(data,data['hours'][hour],.5)


def test_real_data_distinct_24h_and_nonzero_first_step(monkeypatch,tmp_path):
    monkeypatch.setenv('LLM_MODE','demo');f,c,k=inputs()
    r=run_agent(f,c,k,dispatch_current_only=True,dispatch_path=tmp_path/'d.jsonl')
    assert len(r['plan'])==24 and r['plan'][0]['battery_kw']>0
    assert r['receipt']['count']==2
    records=[json.loads(x) for x in (tmp_path/'d.jsonl').read_text().splitlines()]
    assert all(x['timestamp']==r['plan'][0]['timestamp'] for x in records)
    trajectories=[[(p['battery_kw'],p['hvac_setpoint_c']) for p in a['plan']] for a in r['candidates']]
    assert len({str(t) for t in trajectories})==len(trajectories)
    for a in r['candidates']:
        assert not check_constraints(a['plan'],k)
        assert sum(p['battery_kw'] for p in a['plan'])<=1e-5
        for p,h,x in zip(a['plan'],c['hours'],f['predictions']):
            if x['abstain']:assert p['battery_kw']==0 and p['action']=='human_review'
            if p['battery_kw']<0:assert h['tariff_period']=='valley'
            if p['battery_kw']>0:assert h['tariff_period']=='peak'
        assert '首步' not in a['selection_reason']['summary'] and '备用电量' in a['selection_reason']['summary']
        assert check_grounding(a['selection_reason']['summary'],display_evidence(a,f['predictions'][0]['timestamp']))
    assert '留电' in r['selection_reason']['summary']
    assert check_grounding(r['reason'],display_evidence({'forecast':f,'candidates':candidate_evidence(r['candidates'])},f['predictions'][0]['timestamp']))
    for text in [r['reason'],r['selection_reason']['summary']]+[p['reason'] for p in r['plan']]:
        assert not reason_format_invalid(text)


def test_all_refused_deduplicates_and_does_not_dispatch(tmp_path):
    f,c,k=inputs()
    for p in f['predictions']:p['abstain']=True
    r=run_agent(f,c,k,dispatch_current_only=True,dispatch_path=tmp_path/'absent.jsonl')
    assert len(r['candidates'])==1 and r['selected']=='rule_hold'
    assert not (tmp_path/'absent.jsonl').exists() and r['receipt']['count']==0
    assert all(p['battery_kw']==0 for p in r['plan'])


def test_english_internal_phrase_templated_without_choice_fallback(monkeypatch):
    f,c,k=inputs()
    for p in f['predictions']:p['abstain']=False
    class Bad:
        def choose_candidate(self,f,c,i):
            best=next(x for x in c if x['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':f"prepared interval upper {max(p['upper'] for p in f['predictions']):.1f} kW"},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=run_agent(f,c,k,provider=Bad(),dispatch_enabled=False)
    assert r['source']=='llm' and r['llm']['explanation_mode']=='template'
    assert not reason_format_invalid(r['reason']) and '按负荷上限' in r['reason']


@pytest.mark.parametrize('soc',[.1,.95])
def test_soc_boundaries(soc,monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');f,c,k=inputs(hour=0);k['initial_soc']=soc
    r=run_agent(f,c,k,dispatch_enabled=False)
    assert not check_constraints(r['plan'],k)
    assert soc-sum(p['battery_kw'] for p in r['plan'])/2000>=soc-1e-8


def test_origin_context_no_future_weather_and_forecast_preserved():
    data=load_replay('normal');row=data['hours'][14]
    f,c,k=from_replay(data,row,.4)
    assert len(f['predictions'])==24 and f['predictions'][0]['timestamp']==row['t']
    assert f['predictions'][-1]['timestamp']==row['forecast_24h'][22]['t']
    for p,source in zip(f['predictions'][1:],row['forecast_24h']):
        assert p['confidence']==source['confidence'] and p['abstain']==source['abstain'] and p['point']==source['point_kw']
    assert all(h['outdoor_temp_c']==row['outdoor_temp_c'] for h in c['hours'])
    assert all(h['pv_kw']==0 for h in c['hours'][1:])
