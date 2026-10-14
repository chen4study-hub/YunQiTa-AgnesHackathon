import copy
import json
from pathlib import Path
import numpy as np
import pandas as pd
import pytest
from src.conformal.byron_daily import calibration_state,issued,BUILDING

CFG=dict(risk_weights=[.7,.15,.1,.05],rejection_fraction=.15,alpha=.095,max_relative_width=1.)
LOOKUP=dict(centers=[.05,.95],coverage=[.95,.8])


def sample():
    rng=np.random.default_rng(3);n=12*24
    f=pd.DataFrame(dict(timestamp=pd.date_range('2017-07-01',periods=n,freq='h',tz='UTC'),building_id=BUILDING,
                        point=100.,y=100+rng.normal(0,10,n),raw_low=95.,raw_high=105.))
    for i in range(4):f[f'risk_{i}']=rng.uniform(0,1,n)
    return f


def test_daily_state_does_not_consult_today_or_future():
    f=sample();day=pd.Timestamp('2017-07-11',tz='UTC');state=calibration_state(f,day,CFG)
    other=f.copy();other.loc[other.timestamp>=day,'y']=1e10
    new=calibration_state(other,day,CFG)
    for k in ('threshold','q','cal_end','cal_start','cal_n'):assert state[k]==new[k]
    a=issued(f[f.timestamp>=day],state,CFG,LOOKUP)
    b=issued(other[other.timestamp>=day],new,CFG,LOOKUP)
    pd.testing.assert_frame_equal(a,b)
    assert state['cal_n']==240 and state['cal_end']<day
    assert ((a.confidence<a.confidence_threshold)==a.abstain).all()


def test_other_building_and_short_history_fail_closed():
    f=sample();f['building_id']='other'
    with pytest.raises(ValueError):calibration_state(f,f.timestamp.iloc[240],CFG)
    f['building_id']=BUILDING
    with pytest.raises(ValueError):calibration_state(f,f.timestamp.iloc[24],CFG)


def test_uploaded_metrics_and_multi_causal_receipt():
    r=json.loads(Path('experiments/round78_calibration.json').read_text())
    assert r['cold_start_enabled'] is False and r['unchanged_point'] and r['assert_no_today_labels']
    assert r['pooled']['n']==8760 and r['pooled']['retained_n']==7380
    assert np.isclose(r['pooled']['retained_coverage'],.9071815718157181)
    assert len(r['multi_metrics'])==24 and all(m['min_cal_rows']>=120 for m in r['rows'])


def test_live_routed_api_uses_daily_gate(tmp_path,monkeypatch):
    from src.api import app as api
    from src.conformal import byron_daily
    from datetime import datetime,timezone,timedelta
    frame=sample().rename(columns={'y':'meter_reading'})
    frame['primary_use']='Office';frame['air_temperature']=25.;frame['cloud_coverage']=0.
    # Real monthly artifact and enough168h lag warmup history.
    import joblib
    bundle=joblib.load('models/byron-expanded-holiday-monthly-v1-2017-07.joblib')
    target=pd.Timestamp('2017-07-12 00:00:00',tz='UTC')
    # Read trusted deployment cohort instead of changing artifact API shape.
    from scripts.research_holiday_calibration import load_data
    d=load_data();d=d[d.timestamp<target]
    cfg=bundle['backbone'].cfg['data']['columns']
    raw=d.rename(columns={'y':cfg['target'],'usage':cfg.get('usage','primary_use'),'air_temperature':cfg.get('air_temperature','air_temperature'),'cloud_coverage':cfg.get('cloud_coverage','cloud_coverage')})
    path=tmp_path/'observations.csv';raw.to_csv(path,index=False);monkeypatch.setenv('BUILDING_DATA_CSV',str(path))
    start=target.to_pydatetime();result=api.routed_holiday_forecast(BUILDING,start,start+timedelta(hours=1))
    expected=byron_daily.one_step(bundle,pd.concat([d,d.iloc[-1:].assign(timestamp=target,y=np.nan)],ignore_index=True),target).iloc[0]
    assert result['predictions'][0]['risk_threshold']==expected.risk_threshold
    assert result['predictions'][0]['abstain']==expected.abstain
