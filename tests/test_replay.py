from src.data.replay_payload import load_replay
import json
import math
from pathlib import Path
from datetime import datetime,timedelta
import numpy as np
import pandas as pd
from jsonschema import Draft202012Validator
from fastapi.testclient import TestClient
from src.api.app import app
from scripts.export_replay import floors

ROOT=Path(__file__).resolve().parents[1]


def test_floor_conservation():
    for point in (0,1.1,333.3,2488.0,1299.8):
        for hour in range(24):
            f=floors(point,hour)
            assert len(f)==40 and min(f)>=0
            assert math.isclose(sum(f),point,abs_tol=1e-8)


def test_exports_schema_and_invariants():
    schema=json.loads((ROOT/'contracts/replay.schema.json').read_text(encoding='utf-8'))
    validator=Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER)
    for scenario in ('sample','normal','peak','abstain'):
        path=ROOT/f'exports/replay/{scenario}.json'
        d=json.loads(path.read_text(encoding='utf-8'))
        validator.validate(d)
        if scenario!='sample':d=load_replay(scenario)
        assert path.stat().st_size<2_000_000
        assert d['meta']['mode']=='auto'
        assert d['meta']['floor_uses'][0]=='lobby'
        assert d['meta']['floor_uses'][13]==d['meta']['floor_uses'][26]=='garden'
        assert {'storage','pv'}.issubset(d['meta']['simulated_fields'])
        times=[datetime.fromisoformat(r['t']) for r in d['hours']]
        assert all(b-a==timedelta(hours=1) for a,b in zip(times,times[1:]))
        assert all(t.date().isoformat()==d['meta']['date'] for t in times)
        soc=.5
        for r in d['hours']:
            assert r['lower_kw']<=r['point_kw']<=r['upper_kw']
            assert len(r['floors_kw'])==40 and math.isclose(sum(r['floors_kw']),r['point_kw'],abs_tol=1e-7)
            assert abs(r['storage']['power_kw'])<=500
            soc-=r['storage']['power_kw']/2000
            assert .1-1e-7<=soc<=.95+1e-7
            assert math.isclose(soc,r['storage']['soc'],abs_tol=.00051)
            assert 0<=r['pv']['power_kw']<=180
            assert math.isclose(r['grid_kw'],max(0,r['actual_kw']-r['storage']['power_kw']-r['pv']['power_kw']),abs_tol=.11)
            if r['abstain']:
                assert r['agent']['status']=='handoff' and r['agent']['actions']==[]
                assert r['storage']['power_kw']==0 and r['abstain_reason']
            else:
                assert r['agent']['status']=='executed'
            assert 0<=r['confidence']<=1
            assert 0<=r['risk_threshold']<=1
            if r['risk_score']>r['risk_threshold']:
                assert r['abstain']
        assert d['meta']['data_source']['license']=='CC BY-SA 4.0'
        assert len(d['campus'])<=150
        assert all(len(b['hourly'])==24 for b in d['campus'])


def test_replay_artifact_provenance():
    p=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    p['model_version']=p['version']
    assert p['version']=='byron-expanded-holiday-monthly-v1'
    for item in p['rows']:
        assert Path(item['artifact']).exists()
        assert pd.Timestamp(item['confidence_validation_end'])<pd.Timestamp(item['month']+'-01',tz='UTC')
    for scenario in ('normal','peak','abstain'):
        d=load_replay(scenario)
        assert d['meta']['model_version']==p['model_version']


def test_export_values_match_real_source_and_cached_model():
    raw=pd.read_csv(ROOT/'data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    raw=raw.set_index('timestamp').Hog_office_Byron
    receipt=json.loads((ROOT/'experiments/round78_calibration.json').read_text())
    cached=pd.concat([pd.read_csv(r['one_path']) for r in receipt['rows']],ignore_index=True)
    cached['wall']=pd.to_datetime(cached.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S')
    cached=cached.set_index('wall')
    for scenario in ('normal','peak','abstain'):
        d=load_replay(scenario)
        for r in d['hours']:
            wall=datetime.fromisoformat(r['t']).strftime('%Y-%m-%d %H:%M:%S')
            assert r['actual_kw']==round(float(raw.loc[wall]),1)
            assert r['point_kw']==round(float(cached.loc[wall,'point']),1)
            assert r['lower_kw']==round(float(cached.loc[wall,'lower']),1)
            assert r['upper_kw']==round(float(cached.loc[wall,'upper']),1)
            assert r['abstain']==bool(cached.loc[wall,'abstain'])


def test_replay_routes():
    c=TestClient(app)
    assert c.get('/buildings').status_code==200
    assert len(c.get('/buildings').json())==163
    index=c.get('/replay');assert index.status_code==200
    assert {x['scenario'] for x in index.json()}=={'normal','peak','abstain'}
    assert c.get('/replay/normal').json()['meta']['scenario']=='normal'
    assert c.get('/replay/sample').status_code==404
    assert c.get('/replay/unknown').status_code==404


def test_rolling_and_aci_do_not_use_current_label():
    from src.conformal.replay_calibration import run
    class Model:
        cfg={'conformal':{'alpha':.095,'risk_weights':[.7,.15,.1,.05],'max_relative_width':10}}
        def _components(self,f,s):return [s,f.disagreement.to_numpy(),np.ones(len(f)),np.ones(len(f))]
    times=pd.date_range('2017-01-01',periods=120,freq='h',tz='UTC')
    cq=pd.DataFrame(dict(timestamp=times[:100],building_id='A',y=10.,point=10.,scale=1.,
                          score=np.linspace(.1,1,100),period=0,disagreement=np.ones(100)))
    ev=pd.DataFrame(dict(timestamp=times[100:],building_id='A',y=10.,point=10.,scale=1.,
                          score=.5,period=0,disagreement=np.ones(20)))
    changed=ev.copy();changed.loc[0,'y']=10000;changed.loc[0,'score']=9990
    for method in ('rolling','aci','mondrian'):
        a=run(Model(),cq,ev,.15,method);b=run(Model(),cq,changed,.15,method)
        assert a.iloc[0].lower==b.iloc[0].lower and a.iloc[0].upper==b.iloc[0].upper
