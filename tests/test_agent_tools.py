from datetime import datetime,timedelta,timezone
import pytest
from src.agent.tools import get_forecast,get_context,simulate_schedule,check_constraints,explain_uncertainty


def fixture():
    times=['2017-07-20T12:00:00-05:00','2017-07-20T13:00:00-05:00']
    f={'predictions':[dict(timestamp=t,point=1000,lower=900,upper=1100,confidence=.95,abstain=False,abstain_reason=None) for t in times]}
    p=[dict(timestamp=t,hvac_setpoint_c=25,battery_kw=100,action='dispatch') for t in times]
    c={'hours':[dict(timestamp=t,outdoor_temp_c=35,pv_kw=100,price_per_kwh=1.2) for t in times]}
    return f,p,c


def test_get_forecast_fetches_each_hour_without_changing_uncertainty():
    start=datetime(2017,7,20,tzinfo=timezone.utc);calls=[]
    def fetch(b,a,z):
        calls.append((a,z));return {'model_version':'v','predictions':[dict(timestamp=a.isoformat(),point=10,lower=8,upper=12,confidence=.8,abstain=True,abstain_reason='risk')]}
    result=get_forecast(fetch,'A',start,start+timedelta(hours=2))
    assert len(calls)==len(result['predictions'])==2 and result['predictions'][0]['abstain_reason']=='risk'


def test_context_uses_configured_prices_and_current_snapshot_soc():
    replay={'meta':{'building_id':'A'},'hours':[
        dict(t='2017-07-20T12:00:00-05:00',outdoor_temp_c=35,storage={'soc':.4},pv={'power_kw':100}),
        dict(t='2017-07-20T13:00:00-05:00',outdoor_temp_c=36,storage={'soc':.3},pv={'power_kw':110})]}
    c=get_context('A',replay['hours'][0]['t'],'2017-07-20T14:00:00-05:00',replay)
    assert c['hours'][0]['price_per_kwh']==1.2
    assert [h['storage_soc'] for h in c['hours']]==[.4,.3]
    assert all(h['storage_soc_source']=='replay.storage.soc' for h in c['hours'])
    with pytest.raises(ValueError):get_context('B',replay['hours'][0]['t'],'2017-07-20T14:00:00-05:00',replay)


def test_linear_simulation_energy_cost_soc_and_comfort():
    f,p,c=fixture();r=simulate_schedule(p,f,context=c)
    assert r['estimated_energy_kwh']==pytest.approx(1540)
    assert r['estimated_cost']==pytest.approx(1848)
    assert r['estimated_peak_kw']==pytest.approx(770)
    assert r['hours'][-1]['soc']==pytest.approx(.4)
    assert [h['estimated_indoor_temp_c'] for h in r['hours']]==[27.4,27.4]
    assert r['comfort_degree_hours']==pytest.approx(.8)
    pre=simulate_schedule(p,f,context=c,precool_hours=[p[0]['timestamp']])
    assert pre['estimated_energy_kwh']==pytest.approx(1590)
    f['predictions'][0]['abstain']=True
    assert simulate_schedule(p,f,context=c)['estimated_cost'] is None


def test_constraints_temperature_power_and_sequential_soc():
    f,p,c=fixture();assert check_constraints(p)==[]
    assert 'battery_power' in check_constraints([{**p[0],'battery_kw':501}])
    assert 'comfort_temperature' in check_constraints([{**p[0],'hvac_setpoint_c':23}])
    assert 'battery_soc' in check_constraints([{**p[0],'battery_kw':500}]*2)
    assert 'battery_soc' in check_constraints([{**p[0],'battery_kw':-500}]*2)


def test_uncertainty_reasons_have_only_supplied_evidence():
    f,p,c=fixture();row=f['predictions'][0];row.update(abstain=True,risk_score=.9,risk_threshold=.8)
    result=explain_uncertainty(f)
    assert len(result)==1 and result[0]['reasons']==['risk_score_above_threshold']
    assert result[0]['evidence']['interval_width']==200
    assert explain_uncertainty({'predictions':[f['predictions'][1]]})==[]
