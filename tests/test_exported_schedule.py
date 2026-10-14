"""Current-hour API, frozen decisions, operations and log receipts share one value."""
import copy
import hashlib
import json
from datetime import datetime,timedelta
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import orchestrator
from src.agent.exported_schedule import exported_inputs,control_text
from src.agent.display_text import display_evidence
from src.agent.orchestrator import check_grounding
from src.data.replay_payload import load_replay,display_precision

ROOT=Path(__file__).resolve().parents[1]
HOURS=(0,4,10,14,19)


@pytest.fixture
def isolated(monkeypatch,tmp_path):
    monkeypatch.setattr(api,'ROOT',tmp_path)
    monkeypatch.setattr(api,'replay_scenario',lambda name:json.loads((ROOT/f'exports/replay/{name}.json').read_text(encoding='utf-8')))
    monkeypatch.setattr('src.agent.takeover.plan_records',lambda *a:{})
    monkeypatch.setenv('LLM_MODE','demo')
    for name in ('rolling_candidate','schedule_candidate','optimize_temperature','evaluate_candidates','simulate_schedule','build_manual_reference'):
        monkeypatch.setattr(orchestrator,name,lambda *a,**k:pytest.fail('existing exported hour must never replan'))
    return tmp_path


@pytest.mark.parametrize('scenario',('normal','peak','abstain'))
@pytest.mark.parametrize('hour',HOURS)
@pytest.mark.parametrize('mode',('demo','real'))
def test_current_controls_cost_candidates_soc_and_receipt_equal_export_and_ops(monkeypatch,isolated,scenario,hour,mode):
    paths=[ROOT/f'exports/replay/{scenario}{suffix}' for suffix in ('.json','.agent-detail.json','.ops.json')]
    before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
    main=json.loads(paths[0].read_text(encoding='utf-8'));row=main['hours'][hour]
    detail=load_replay(scenario)['hours'][hour]
    ops=json.loads(paths[2].read_text(encoding='utf-8'))['hours'][hour]
    selected=row['agent']['selected'];frozen=next(c for c in detail['agent']['candidates'] if c['candidate_id']==selected)
    if mode=='real':
        class Fake:
            def choose_candidate(self,forecast,candidates,instruction):
                assert f'Decision is locked to {selected}' in instruction
                # Even a numerically grounded but WRONG direction cannot leak.
                return {'choice':{'candidate_id':selected,'reason':'储能待机 0 kW。电费 9,549.5 元。峰值 999999.9 kW。当前小时可正常执行。'},
                    'llm':{'mode':'real','reason':'call_succeeded'}}
        monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    request={'building_id':main['meta']['building_id'],'scenario':scenario,'start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat(),'display_date':'2026-10-13'}
    response=TestClient(api.app).post('/schedule',json=request)
    assert response.status_code==200,response.text
    out=response.json();command=out['plan'][0]
    assert out['decision_source']=='exported_hour' and out['selected']==selected
    if mode=='real' and not row['abstain']:assert out['source']=='llm' and out['explanation_source']=='llm'
    assert command['timestamp']==row['t']==ops['source_t']
    assert command['hvac_setpoint_c']==row['agent']['hvac_setpoint_c']==ops['hvac_setpoint_c']
    assert command['battery_kw']==row['storage']['power_kw']==ops['storage']['power_kw']
    assert out['storage']==row['storage']==ops['storage']
    assert command['battery_kw']==display_precision(frozen)['plan'][0]['battery_kw']
    assert out['estimated_cost']==display_precision(frozen)['simulation']['estimated_cost']
    assert out['estimated_savings']==display_precision(frozen)['simulation']['estimated_savings']
    for candidate,original in zip(out['candidates'],detail['agent']['candidates']):
        assert candidate['candidate_id']==original['candidate_id']
        for p,q in zip(candidate['plan'],display_precision(original)['plan']):
            assert {k:p[k] for k in ('timestamp','battery_kw','hvac_setpoint_c','prepared_upper_kw')}=={k:q[k] for k in ('timestamp','battery_kw','hvac_setpoint_c','prepared_upper_kw')}
        assert candidate['simulation']==display_precision(original)['simulation']
        assert candidate['objective_metrics']==display_precision(original)['objective_metrics']
    assert control_text(command) in out['reason']
    assert out['reason']==out['explanation'] and not any(w in out['reason'] for w in ('容差','编号','999999.9','999,999.9','9,549.5'))
    evidence=display_evidence(out['candidates'],row['t']);evidence['power_magnitude']=abs(command['battery_kw'])
    assert check_grounding(out['reason'],evidence)
    refused=row['abstain'];assert out['needs_human']==refused
    assert out['receipt']['count']==(0 if refused else 2) and not out['receipt']['device_connected']
    log=isolated/'logs/dispatch.jsonl'
    if refused:assert not log.exists()
    else:
        records=[json.loads(s) for s in log.read_text(encoding='utf-8').splitlines()]
        assert len(records)==2
        assert records[0]['command']=={'setpoint_c':command['hvac_setpoint_c']}
        assert records[1]['command']=={'battery_kw':command['battery_kw']}
        assert all(r['timestamp']==row['t'] and r['transport']=='log_only' for r in records)
    assert before==[hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]


def test_0400_root_cause_is_post_command_soc_not_forecast_window():
    data=load_replay('normal');row=data['hours'][4]
    f,c,k,agent=exported_inputs(data,row)
    assert len(f['predictions'])==24
    assert k['initial_soc']==row['storage']['soc']+row['storage']['power_kw']/2000
    assert k['initial_soc']==c['hours'][0]['storage_soc']
    assert round(k['initial_soc']*100,4)==80.75
    assert round(row['storage']['soc']*100,4)==90.1186
    assert agent['selected']=='rule_full'
    assert round(agent['candidates'][0]['simulation']['estimated_cost'],1)==9394.3


@pytest.mark.parametrize('mutation',('storage','setpoint','selected','refusal','window','constraint'))
def test_invalid_export_or_incompatible_constraints_fail_closed_without_log(monkeypatch,isolated,mutation):
    data=load_replay('normal');row=copy.deepcopy(data['hours'][4]);constraints=None
    if mutation=='storage':row['storage']['power_kw']=0.
    elif mutation=='setpoint':row['agent']['hvac_setpoint_c']=24.
    elif mutation=='selected':row['agent']['selected']='missing'
    elif mutation=='refusal':row['abstain']=True
    elif mutation=='window':row['agent']['candidates'][0]['plan'][0]['timestamp']=data['hours'][5]['t']
    else:constraints={'battery_max_kw':0}
    monkeypatch.setattr(api,'replay_hour',lambda *a:(data,row))
    req=api.ScheduleWindow(building_id=data['meta']['building_id'],scenario='normal',start=row['t'],
        end=datetime.fromisoformat(row['t'])+timedelta(hours=1),constraints=constraints,display_date='2026-10-13')
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:api.agent_schedule(req,True)
    assert exc.value.status_code==422 and not (isolated/'logs/dispatch.jsonl').exists()


@pytest.mark.parametrize('scenario',('normal','peak','abstain'))
def test_every_exported_hour_passes_exact_validation(scenario):
    data=load_replay(scenario)
    for row in data['hours']:exported_inputs(data,row)


def test_explain_is_read_only_and_wrong_llm_selection_cannot_change_decision(monkeypatch,isolated):
    data=load_replay('normal');row=data['hours'][4]
    class Wrong:
        def choose_candidate(self,*a):return {'choice':{'candidate_id':'rule_hold','reason':'选择保持设定。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Wrong)
    req=api.ScheduleWindow(building_id=data['meta']['building_id'],scenario='normal',start=row['t'],
        end=datetime.fromisoformat(row['t'])+timedelta(hours=1),display_date='2026-10-13')
    out=api.agent_schedule(req,False)
    assert out['selected']=='rule_full' and out['plan'][0]['battery_kw']==-187.4
    assert out['estimated_cost']==9394.3 and out['explanation_source']=='template'
    assert out['receipt']['count']==0 and not (isolated/'logs/dispatch.jsonl').exists()


def test_takeover_created_during_frozen_prose_stops_dispatch(monkeypatch,isolated):
    data=load_replay('normal');row=data['hours'][4];active={}
    monkeypatch.setattr('src.agent.takeover.plan_records',lambda *a:dict(active))
    class During:
        def choose_candidate(self,*a):
            active[row['t']]={'id':'late','building_id':data['meta']['building_id'],'operator_id':'值班员甲',
                'hvac_setpoint_c':26.,'storage_mode':'idle','storage_power_kw':0.,'battery_kw':0.,'reason':'检查设备'}
            return {'choice':{'candidate_id':row['agent']['selected'],'reason':'选择当前方案。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(api,'OpenAICompatibleProvider',During)
    req=api.ScheduleWindow(building_id=data['meta']['building_id'],scenario='normal',start=row['t'],
        end=datetime.fromisoformat(row['t'])+timedelta(hours=1),display_date='2026-10-13')
    out=api.agent_schedule(req,True)
    assert out['status']=='manual' and out['plan'][0]['battery_kw']==0.
    assert out['receipt']['count']==0 and not (isolated/'logs/dispatch.jsonl').exists()


@pytest.mark.parametrize('key,value',[('initial_soc',.5),('battery_capacity_kwh',100000),('peak_target_kw',10)])
def test_request_cannot_change_locked_planning_basis(key,value):
    data=load_replay('normal')
    with pytest.raises(ValueError,match='planning basis'):
        exported_inputs(data,data['hours'][4],{key:value})


def test_frozen_prose_rejects_worded_control_and_numeric_contradictions():
    from src.agent.exported_schedule import frozen_prose
    text='电池处于待机。功率为零。温度二十七度。充电已停止。费用更低。选择当前方案。'
    assert frozen_prose(text)=='选择当前方案。'


def test_frozen_current_takeover_and_dispatch_boundary_remain_authoritative(monkeypatch,isolated):
    data=load_replay('normal');row=data['hours'][4]
    record={'id':'manual-test','building_id':data['meta']['building_id'],'operator_id':'值班员甲',
        'hvac_setpoint_c':26.,'storage_mode':'charge','storage_power_kw':50.,'battery_kw':-50.,'reason':'检查设备'}
    monkeypatch.setattr('src.agent.takeover.plan_records',lambda *a:{row['t']:record})
    class NoProvider:
        def choose_candidate(self,*a):pytest.fail('current takeover must bypass LLM')
    monkeypatch.setattr(api,'OpenAICompatibleProvider',NoProvider)
    req=api.ScheduleWindow(building_id=data['meta']['building_id'],scenario='normal',start=row['t'],
        end=datetime.fromisoformat(row['t'])+timedelta(hours=1),display_date='2026-10-13')
    out=api.agent_schedule(req,True)
    assert out['status']=='manual' and out['mode']=='manual' and out['needs_human']
    assert out['plan'][0]['hvac_setpoint_c']==26. and out['plan'][0]['battery_kw']==-50.
    assert out['estimated_cost'] is None and not out['dispatch_enabled']
    assert out['receipt']['count']==0 and not (isolated/'logs/dispatch.jsonl').exists()
