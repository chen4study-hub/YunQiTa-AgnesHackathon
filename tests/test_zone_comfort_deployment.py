import copy,json
from pathlib import Path
from datetime import datetime
import pytest
from src.agent.zone_comfort import maximum_zone_temperature,safe_setpoint,plan_safe
from src.agent.tools import tool_config
from src.data.replay_payload import load_replay,load_detail
from src.agent.rolling_context import from_replay
from src.ops.metrics import floor_rows
from scripts.compact_replay import validate_pair


@pytest.mark.parametrize('name',['normal','peak','abstain'])
def test_exports_all_zone_comfort_and_references(name):
    full=load_replay(name);main=load_replay(name,hydrate=False);detail=load_detail(main)
    validate_pair(main,detail,full)
    for i,row in enumerate(full['hours']):
        fs,_,_=floor_rows(full['meta']['date'],i,row,full['meta']['floor_uses'])
        zones=[z['temp_c'] for f in fs for z in f['zones']]
        if 7<=i<=20:assert max(zones)<=27.
        assert '仅比较可自动调度的时段，拒绝时段不计费用。' not in row['agent']['explanation']
        if not row['abstain']:assert row['agent']['explanation'].startswith('空调设定')
        f,c,k=from_replay(full,row,row['storage']['soc'])
        for candidate in row['agent']['candidates']:assert plan_safe(candidate['plan'],f['predictions'],c['hours'])
        for ref in row['agent']['manual_reference']:
            j=next(j for j,p in enumerate(f['predictions']) if p['timestamp']==ref['timestamp'])
            assert safe_setpoint(f['predictions'][j],c['hours'][j],ref['hvac_setpoint_c'],k)==ref['hvac_setpoint_c']
        assert ((row['confidence']<row['confidence_threshold'])==row['abstain'])


def test_hot_extreme_has_no_feasible_setpoint_and_fails_closed():
    pred=dict(timestamp='2017-07-20T12:00:00-05:00',point=1200.)
    h=dict(outdoor_temp_c=100.)
    with pytest.raises(ValueError):safe_setpoint(pred,h,27.,tool_config()['equipment'])


def test_comfort_matches_read_only_ops_and_monotone_adjustment():
    data=load_replay('peak');row=data['hours'][12];f,c,k=from_replay(data,row,.5)
    temp=safe_setpoint(f['predictions'][0],c['hours'][0],26.7,k)
    assert temp<26.7 and maximum_zone_temperature(f['predictions'][0],c['hours'][0],temp)<=27.
    higher=round(temp+.1,1)
    assert maximum_zone_temperature(f['predictions'][0],c['hours'][0],higher)>27.
