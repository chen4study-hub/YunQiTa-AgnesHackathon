"""Duration, planned setpoint tolerance and one-episode alert aggregation."""
import copy
import pytest
from src.ops.rules import events
from src.ops.config import HOUR_MS


def row(h, temp=28, setpoint=26.7, floors=12, zones=('east',)):
    return {'offset_ms':h*HOUR_MS,'hvac_setpoint_c':setpoint,
            'environment':{'co2_ppm':500,'pm25_ug_m3':10}, 'storage':{'soc':.5},
            'floors':[{'floor':f,'zones':[{'id':z,'temp_c':temp} for z in zones]}
                      for f in range(1,floors+1)]}


def test_temperature_episode_merges_floors_and_has_causal_onset():
    hours=[row(0),row(1),row(2),row(3),row(4,temp=26)]
    alerts,orders=events('2017-10-23',hours)
    assert len(alerts)==len(orders)==1
    a=alerts[0]
    assert a['offset_ms']==2*HOUR_MS and a['resolved_offset_ms']==4*HOUR_MS
    assert '12 个区域（涉及 12 层）' in a['content'] and '东区' in a['content']
    assert '高于 27.5 °C 已持续 2 小时' in a['content']
    assert orders[0]['alert_id']==a['id'] and orders[0]['content']==a['content']
    # Future spread is not put into the content of a past onset.
    altered=copy.deepcopy(hours)
    altered[3]=row(3,floors=40,zones=('east','west'))
    assert events('2017-10-23',altered)[0][0]['content']==a['content']
    assert not events('2017-10-23',hours[:2])[0]


@pytest.mark.parametrize('setpoint', (26,26.7,27))
def test_planned_temperature_has_tolerance(setpoint):
    assert not events('2017-10-23',[row(h,temp=setpoint+.4,setpoint=setpoint) for h in range(6)])[0]


def test_material_temperature_deviation_still_alerts_at_allowed_setpoint():
    alerts,_=events('2017-10-23',[row(h,temp=28,setpoint=27) for h in range(4)])
    assert len(alerts)==1 and alerts[0]['offset_ms']==2*HOUR_MS


def test_one_hour_spike_or_rotating_zones_cannot_prove_duration():
    assert not events('2017-10-23',[row(0),row(1,temp=26),row(2)])[0]
    assert not events('2017-10-23',[row(h,zones=('east',) if h%2 else ('west',)) for h in range(6)])[0]


def test_recovery_splits_distinct_continuous_episodes():
    hours=[row(h,temp=26 if h==3 else 28) for h in range(8)]
    alerts,orders=events('2017-10-23',hours)
    assert len(alerts)==len(orders)==2
    assert [a['offset_ms'] for a in alerts]==[2*HOUR_MS,6*HOUR_MS]
    assert alerts[0]['resolved_offset_ms']==3*HOUR_MS
    assert alerts[1]['resolved_offset_ms'] is None
    assert len({a['id'] for a in alerts})==2


def test_continuous_episode_does_not_duplicate_when_asset_set_changes():
    hours=[row(0),row(1),row(2),row(3,zones=('east','west')),
           row(4,zones=('west',)),row(5,zones=('west',)),row(6,temp=26)]
    alerts,_=events('2017-10-23',hours)
    assert len(alerts)==1 and alerts[0]['resolved_offset_ms']==6*HOUR_MS


def test_duration_rejects_missing_hour_evidence():
    with pytest.raises(ValueError,match='contiguous'):
        events('2017-10-23',[row(0),row(2),row(3)])



def test_alert_boundary_and_wording_match_threshold():
    assert not events('2017-10-23',[row(h,temp=27.5) for h in range(4)])[0]
    alerts,_=events('2017-10-23',[row(h,temp=27.6,zones=('east','west')) for h in range(4)])
    assert alerts[0]['content'].startswith('东区、西区 24 个区域（涉及 12 层）室温高于 27.5')
    assert not events('2017-10-23',[row(h,temp=28,setpoint=27.5) for h in range(4)])[0]
