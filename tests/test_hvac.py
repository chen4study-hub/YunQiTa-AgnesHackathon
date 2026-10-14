from src.data.replay_payload import load_replay
import copy
import json
from datetime import datetime,timedelta
from pathlib import Path
import numpy as np
import pandas as pd
import pytest
from src.data.hvac import load_meters,origin_readings,estimate,partition,ASSUMPTIONS,attach_hvac
from scripts.replay_floor_allocation import floors


def test_official_hashes_sizes_byron_and_independent_energy_units():
    tables,receipts=load_meters();lock=json.loads(Path('experiments/bdg2_thermal_sources.json').read_text())
    for name,r in receipts.items():assert r['sha256']==lock['files'][name]['sha256'] and r['bytes']==lock['files'][name]['bytes']
    assert all(len(s)==17544 for s in tables.values())
    raw=origin_readings('2017-07-20T00:00:00-05:00',tables)
    assert raw['chilledwater']['raw_kwh']==7364.8536 and raw['steam']['raw_kwh']==3259.6875
    h,e=estimate(raw,'2017-07-20T00:00:00-05:00',2000.,1800.)
    assert h['thermal_kw']==7364.9 and e==round(7364.8536*ASSUMPTIONS['cooling_auxiliary_electric_fraction'],1) and not h['cap_applied']
    h,e=estimate(raw,'2017-01-20T00:00:00-06:00',2000.,1800.)
    assert h['thermal_kw']==3259.7 and e==round(3259.6875*ASSUMPTIONS['steam_auxiliary_electric_fraction'],1)  # building auxiliaries, no steamCOP


def test_missing_is_past_only_no_future_leak_and_gap_is_bounded():
    t=pd.date_range('2017-07-20',periods=30,freq='h');s=pd.Series(np.nan,index=t);s.iloc[0]=1000.;s.iloc[-1]=999999.
    tables={'chilledwater':s,'steam':pd.Series(500.,index=t)}
    r=origin_readings('2017-07-20T12:00:00-05:00',tables)
    assert r['chilledwater']['raw_kwh'] is None and r['chilledwater']['effective_kwh']==1000.
    h,e=estimate(r,'2017-07-20T12:00:00-05:00',1000.,900.)
    assert h['quality']=='past_fill' and e==round(1000.*ASSUMPTIONS['cooling_auxiliary_electric_fraction'],1) and r['chilledwater']['age_hours']==12.
    r=origin_readings('2017-07-21T01:00:00-05:00',tables)
    h,e=estimate(r,'2017-07-21T01:00:00-05:00',1000.,900.)
    assert h['quality']=='missing' and e is None
    assert partition(floors(100.,10),None)==(None,None)


def test_caps_rounding_partition_conservation_and_share():
    r={k:dict(raw_kwh=100000.,effective_kwh=100000.,source_wall_time='2017-07-20T00:00:00',age_hours=0.) for k in ['chilledwater','steam']}
    for total,actual in [(100.,90.),(90.,100.),(0.,10.),(100.,0.),(.1,.1)]:
        h,e=estimate(r,'2017-07-20T00:00:00-05:00',total,actual)
        assert 0<=e<=min(total,actual) and h['cap_applied']
        total_floor=floors(total,10);a,b=partition(total_floor,e)
        assert sum(round(x*10) for x in a)==round(e*10)
        assert all(round(x*10)+round(y*10)==round(z*10) for x,y,z in zip(a,b,total_floor))
    with pytest.raises(ValueError):partition(floors(100.,10),101.)


def test_export_hvac_matches_thermal_and_floor_accounting_and_future_persistence():
    tables,_=load_meters()
    for name in ['normal','peak','abstain']:
        d=load_replay(name)
        assert d['schema_version']=='1.5' and d['meta']['hvac_method']==ASSUMPTIONS
        assert {'hvac_electric_estimate_kw','hvac_electric_estimated_share','floors_hvac_electric_estimate_kw'}.issubset(d['meta']['estimated_fields'])
        for row in d['hours']:
            readings=origin_readings(row['t'],tables)
            expected,e=estimate(readings,row['t'],row['point_kw'],row['actual_kw']);assert row['hvac']==expected
            assert row['hvac_electric_estimate_kw']==e
            for r in [row]+row['forecast_24h']:
                bound=r['actual_kw'] if 'actual_kw' in r else r['point_kw'];value=r['hvac_electric_estimate_kw']
                if value is None:assert r['hvac_electric_estimated_share'] is None;continue
                assert value<=bound and value<=r['point_kw']
                assert r['hvac_electric_estimated_share']==pytest.approx(round(value/bound,6)) if bound else r['hvac_electric_estimated_share'] is None
                a,b=r['floors_hvac_electric_estimate_kw'],r['floors_non_hvac_estimate_kw']
                assert sum(round(x*10) for x in a)==round(value*10)
                assert all(round(x*10)+round(y*10)==round(z*10) for x,y,z in zip(a,b,r['floors_kw']))
            for p in row['forecast_24h']:
                assert p['hvac']['basis']=='persistence_at_origin' and p['hvac']['origin']==row['t']
                assert p['hvac']['effective_readings']==readings
                expected,e=estimate(readings,p['t'],p['point_kw'],origin=row['t']);assert p['hvac']==expected and p['hvac_electric_estimate_kw']==e
        summary=d['energy_summary'];known=[r for r in d['hours'] if r['hvac_electric_estimate_kw'] is not None]
        assert summary['valid_hours']==len(known)
        assert summary['hvac_electric_estimate_kwh']==pytest.approx(sum(r['hvac_electric_estimate_kw'] for r in known))
        assert summary['hvac_electric_estimated_share']==pytest.approx(round(sum(r['hvac_electric_estimate_kw'] for r in known)/sum(r['actual_kw'] for r in known),4))


def test_export_timestep_changes_after_origin_cannot_affect_future_hvac():
    tables,receipts=load_meters();d=load_replay('normal');a=copy.deepcopy(d)
    attach_hvac(a,(tables,receipts));origin=datetime.fromisoformat(d['hours'][0]['t']).replace(tzinfo=None)
    changed={k:s.copy() for k,s in tables.items()}
    for s in changed.values():s.loc[s.index>origin]=99999999.
    b=copy.deepcopy(d);attach_hvac(b,(changed,receipts))
    assert a['hours'][0]['forecast_24h']==b['hours'][0]['forecast_24h']
