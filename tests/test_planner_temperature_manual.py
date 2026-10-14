"""Planner-specific guards and independent operator reference contract."""
import copy
import json
from datetime import datetime, timedelta
from pathlib import Path
import pytest
from jsonschema import Draft202012Validator
from src.agent.orchestrator import run_agent
from src.agent.manual_reference import manual_reference_at
from src.agent.temperature_planner import optimize_temperature, control_metrics
from src.agent.storage_planner import rolling_candidate
from src.agent.tools import tool_config, check_constraints
from scripts.verify_planner_export import OfflineChoice


def inputs():
    start = datetime.fromisoformat('2026-10-12T00:00:00+08:00')
    times = [(start+timedelta(hours=i)).isoformat() for i in range(24)]
    rows = []; hours = []
    for i, t in enumerate(times):
        period = 'valley' if i<7 else 'peak' if 10<=i<20 else 'flat'
        point = 300. if i<10 else 1100. if i<20 else 600.
        rows.append(dict(timestamp=t, point=point, lower=point*.8, upper=point*1.2,
                         abstain=False, confidence=.95, abstain_reason=None))
        hours.append(dict(timestamp=t, tariff_period=period, pv_kw=0., outdoor_temp_c=30.,
                          price_per_kwh={'valley':.35,'flat':.75,'peak':1.2}[period]))
    return dict(building_id='A', predictions=rows), dict(hours=hours), tool_config()['equipment']


def test_each_candidate_hourly_comfort_and_cost_peak_guards():
    f, c, k = inputs(); before_forecast = copy.deepcopy(f)
    r = run_agent(f, c, k, provider=OfflineChoice(), dispatch_enabled=False)
    for candidate in r['candidates']:
        comparison = candidate['temperature_optimization']
        assert comparison['applied']
        assert comparison['after']==control_metrics(candidate['plan'], f['predictions'], c['hours'])
        for key, value in comparison['before'].items():
            assert comparison['after'][key]<=value+1e-7
        temperatures = [p['hvac_setpoint_c'] for p in candidate['plan']]
        assert 24<=min(temperatures)<=25.5<max(temperatures)<27
        assert all(t==round(t,1) for t in temperatures)
        assert not check_constraints(candidate['plan'], k)
    assert any(p['action']=='precool' for candidate in r['candidates'] for p in candidate['plan'])
    selected=next(c for c in r['candidates'] if c['candidate_id']==r['selected'])
    guard=selected['temperature_optimization']
    assert guard['selection_guard_passed']
    assert all(guard['after'][key]<=value+1e-7 for key,value in guard['selection_guard_caps'].items())
    assert f==before_forecast and r['manual_reference']==[]


def test_refused_execution_zero_but_independent_upper_reference_nonzero(tmp_path):
    f, c, k = inputs()
    for i in [5,6,10,11,12]: f['predictions'][i]['abstain']=True
    old = copy.deepcopy((f, c, k)); path = tmp_path/'dispatch.jsonl'
    r = run_agent(f, c, k, provider=OfflineChoice(), dispatch_path=path)
    for i in [5,6,10,11,12]:
        assert r['plan'][i]['battery_kw']==0
        from src.agent.zone_comfort import plan_safe
        assert plan_safe([r['plan'][i]],[f['predictions'][i]],[c['hours'][i]])
    refs = r['manual_reference']; assert len(refs)==5
    assert any(p['battery_kw']<0 and p['storage_mode']=='charge' for p in refs)
    assert any(p['battery_kw']>0 and p['storage_mode']=='discharge' for p in refs)
    assert [p['suggested_duration_hours'] for p in refs]==[2,2,3,3,3]
    assert [p['remaining_duration_hours'] for p in refs]==[2,1,3,2,1]
    for p in refs:
        assert p['requires_confirmation'] and '值班员' in p['reason'] and '确认' in p['reason'] and len(p['reason'])<=60
        assert p['timestamp'] not in path.read_text(encoding='utf-8')
        assert .1<=p['reference_soc_before']<=.95 and .1<=p['reference_soc_after']<=.95
    assert (f, c, k)==old
    found = manual_reference_at(r, '2026-10-12', 10)
    assert found==refs[2]
    found['battery_kw']=999
    assert refs[2]['battery_kw']!=999
    assert manual_reference_at(r, '2026-10-13', 10) is None
    assert manual_reference_at(r, '2026-10-12', 9) is None
    schema = json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator({'$defs':schema['$defs'], 'type':'array',
                         'items':{'$ref':'#/$defs/manual_reference_row'}}).validate(refs)


@pytest.mark.parametrize('soc',[.1,.5,.95])
def test_all_refused_upper_reference_safe_terminal_reserve(soc):
    f, c, k = inputs(); k['initial_soc']=soc
    for p in f['predictions']: p['abstain']=True
    r = run_agent(f, c, k, dispatch_enabled=False)
    assert r['receipt']['count']==0 and len(r['candidates'])==1
    refs = r['manual_reference']; assert len(refs)==24
    commands = [dict(hvac_setpoint_c=p['hvac_setpoint_c'], battery_kw=p['battery_kw'],
                     action='dispatch') for p in refs]
    assert not check_constraints(commands, k)
    assert sum(p['battery_kw'] for p in refs)<=1e-5
    assert all(p['suggested_duration_hours']==24 for p in refs)


def test_cross_date_segment_query_and_invalid_hour():
    f,c,k = inputs()
    for i,p in enumerate(f['predictions']):
        t=(datetime.fromisoformat('2026-10-12T22:00:00+08:00')+timedelta(hours=i)).isoformat()
        p['timestamp']=t;c['hours'][i]['timestamp']=t;p['abstain']=i<4
    r=run_agent(f,c,k,dispatch_enabled=False)
    assert manual_reference_at(r,'2026-10-13',0)['suggested_duration_hours']==4
    for hour in [-1,24,True,1.5]:
        with pytest.raises(ValueError):manual_reference_at(r,'2026-10-12',hour)


def test_zero_power_flat_tariff_stays_comfortable():
    f,c,k=inputs(); k['battery_max_kw']=0
    for h in c['hours']:h['tariff_period']='flat';h['price_per_kwh']=.75
    candidate=rolling_candidate(f,c,k,'rule_hold',0)
    optimize_temperature(candidate,f,c,k)
    from src.agent.zone_comfort import plan_safe
    assert plan_safe(candidate['plan'],f['predictions'],c['hours'])
    assert all(p['hvac_setpoint_c']<=25.5 for p in candidate['plan'])


def test_guard_prevents_tolerance_band_switch_regression():
    from src.agent.selection import policy_order
    candidates=[dict(candidate_id='safe', objective_metrics=dict(upper_grid_peak_kw=1000.,energy_cost_cny=100.),
                     temperature_optimization=dict(selection_guard_passed=True)),
                dict(candidate_id='unsafe', objective_metrics=dict(upper_grid_peak_kw=990.,energy_cost_cny=110.),
                     temperature_optimization=dict(selection_guard_passed=False))]
    ordered,minimum,tolerance=policy_order(candidates)
    assert ordered[0]['candidate_id']=='safe' and minimum==1000.


def test_export_segments_follow_actual_handoff_not_window_predictions():
    from src.agent.manual_reference import align_export_segments
    start=datetime.fromisoformat('2026-10-12T00:00:00+08:00')
    hours=[]
    for i in range(24):
        t=(start+timedelta(hours=i)).isoformat()
        hours.append(dict(t=t,agent=dict(status='handoff' if 8<=i<=19 else 'executed',
                    manual_reference=[dict(timestamp=t,suggested_duration_hours=5,
                                           remaining_duration_hours=5)])))
    data=dict(hours=hours);align_export_segments(data)
    for i,row in enumerate(hours):
        refs=row['agent']['manual_reference']
        if 8<=i<=19:
            assert refs[0]['suggested_duration_hours']==12
            assert refs[0]['remaining_duration_hours']==20-i
            assert refs[0]['segment_start']==hours[8]['t']
        else:assert refs==[]
    from src.data.replay_payload import display_precision
    assert type(display_precision(hours[8]['agent'])['manual_reference'][0]['remaining_duration_hours']) is int


def test_manual_prepeak_flat_charge_is_allowed_but_never_dispatches():
    f,c,k=inputs()
    # Horizon starts with flat hours and no preceding valley replenishment.
    f['predictions']=f['predictions'][8:];c['hours']=c['hours'][8:]
    k['initial_soc']=.2
    for p in f['predictions']:p['abstain']=True
    r=run_agent(f,c,k,dispatch_enabled=False)
    ref=r['manual_reference'][0]
    assert ref['battery_kw']<0 and ref['storage_mode']=='charge'
    assert r['plan'][0]['battery_kw']==0 and r['receipt']['count']==0
    assert len(ref['reason'])<=60 and 'kWh' in ref['reason']


def test_peak_08_reference_not_default_and_main_keeps_only_current():
    from src.data.replay_payload import load_replay,split_payload
    from src.agent.rolling_context import from_replay
    data=load_replay('peak');row=data['hours'][8]
    f,c,k=from_replay(data,row,.95)
    result=run_agent(f,c,k,provider=OfflineChoice(),dispatch_enabled=False)
    ref=manual_reference_at(result,datetime.fromisoformat(row['t']).date().isoformat(),8)
    assert ref is not None and (ref['hvac_setpoint_c']!=25.5 or round(ref['battery_kw'],1)!=0.)
    assert len(ref['reason'])<=60 and 'kWh' in ref['reason']
    future=copy.deepcopy(ref);future['timestamp']=(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()
    result['manual_reference'].append(future)
    row['agent']['manual_reference']=result['manual_reference']
    main,detail=split_payload(data)
    assert main['hours'][8]['agent']['manual_reference'][0]['timestamp']==row['t']
    assert len(main['hours'][8]['agent']['manual_reference'])==1
    assert detail['hours']['8']['agent']['manual_reference']==result['manual_reference']
    assert len(detail['hours']['8']['agent']['manual_reference'])>1


def test_temperature_varies_with_hourly_tariff_weather_and_load():
    f,c,k=inputs();k['battery_max_kw']=0
    for i,(p,h) in enumerate(zip(f['predictions'],c['hours'])):
        if 10<=i<20:
            p['point']=700.+50*(i-10);p['upper']=p['point']*1.2
            h['outdoor_temp_c']=30.+(i%3)*2.
    candidate=rolling_candidate(f,c,k,'rule_hold',0)
    optimize_temperature(candidate,f,c,k)
    plan=candidate['plan']
    peak_temps=[p['hvac_setpoint_c'] for p,h in zip(plan,c['hours']) if h['tariff_period']=='peak']
    assert len(set(peak_temps))>=3
    assert all(24<=t<=27 for t in peak_temps)
    assert any(24.5<=p['hvac_setpoint_c']<=25. for p in plan[8:10])
    assert len({p['hvac_setpoint_c'] for p in plan})>=5
    for p,h in zip(plan,c['hours']):
        from src.agent.zone_comfort import maximum_zone_temperature,occupied
        pred=next(r for r in f['predictions'] if r['timestamp']==p['timestamp'])
        assert not occupied(pred) or maximum_zone_temperature(pred,h,p['hvac_setpoint_c'])<=27.
    # A hotter hour with identical load/tariff must lower or retain its target.
    cold=copy.deepcopy(candidate)
    c['hours'][10]['outdoor_temp_c']=42.
    cold=rolling_candidate(f,c,k,'rule_hold',0);optimize_temperature(cold,f,c,k)
    assert cold['plan'][10]['hvac_setpoint_c']<=plan[10]['hvac_setpoint_c']


def test_genuine_manual_hold_has_numeric_soc_limit_not_generic_default():
    f,c,k=inputs();k['initial_soc']=.1;k['battery_max_kw']=0
    for p,h in zip(f['predictions'],c['hours']):
        p['abstain']=True;h['tariff_period']='flat'
    r=run_agent(f,c,k,dispatch_enabled=False)
    ref=r['manual_reference'][0]
    assert ref['hvac_setpoint_c']==25.5 and ref['battery_kw']==0.
    assert '电量10%' in ref['reason'] and '下限10%' in ref['reason'] and '可放0 kWh' in ref['reason']
    assert len(ref['reason'])<=60


def test_manual_reason_units_grouping_and_length():
    import re
    from src.agent.manual_reference import build_manual_reference
    f,c,k=inputs();k['initial_soc']=.95
    for p in f['predictions']:p['abstain']=True
    f['predictions'][19].update(point=2000.,upper=2400.)
    refs=build_manual_reference(f,c,k)
    k['initial_soc']=.5
    refs+=build_manual_reference(f,c,k)
    reasons=[p['reason'] for p in refs]
    assert any('1,700 kWh' in reason for reason in reasons)
    assert any('250 kW' in reason for reason in reasons)
    for reason in reasons:
        assert len(reason)<=60 and '％' not in reason
        assert re.search(r'\d+\.\d °C',reason)
        assert not re.search(r'\d(?:℃|kW|kWh)|\d %|(?<![\d,])\d{4,} kWh',reason)
