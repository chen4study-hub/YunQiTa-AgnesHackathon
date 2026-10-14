from src.data.replay_payload import load_replay
import hashlib
import json
from pathlib import Path
from datetime import datetime,timedelta
import joblib
import numpy as np
import pandas as pd
import pytest
from src.models.direct_multi import features,COLUMNS,predict
from scripts.backtest_direct24 import summarize
from scripts.replay_floor_allocation import floors,USES


def synthetic():
    times=pd.date_range('2016-01-01',periods=300,freq='h',tz='UTC')
    return pd.DataFrame(dict(timestamp=times,y=np.arange(300.)+500.,air_temperature=np.arange(300.)/10))


def test_features_do_not_consume_future_load_or_weather():
    d=synthetic();origin=d.timestamp.iloc[220];a=features(d)
    changed=d.copy();changed.loc[changed.timestamp>origin,['y','air_temperature']]=99999.
    b=features(changed);a=a[a.origin.eq(origin)];b=b[b.origin.eq(origin)]
    pd.testing.assert_frame_equal(a[COLUMNS].reset_index(drop=True),b[COLUMNS].reset_index(drop=True))
    assert len(a)==24 and a.weather_persistence.eq(22.).all()
    assert a[a.horizon.eq(24)].anchor.iloc[0]==d.y.iloc[220]
    assert 'y' not in COLUMNS and 'target' not in COLUMNS


def test_predictions_ignore_current_future_labels_and_have_horizon_calibration():
    index=json.loads(Path('experiments/multi_horizon_v1_index.json').read_text())
    item=index['rows'][6];bundle=joblib.load(item['artifact'])
    f=features(synthetic());f=f[f.origin.eq(f.origin.max())]
    a=predict(bundle,f,bundle['confidence_lookup']);f=f.copy();f['y']=999999.
    b=predict(bundle,f,bundle['confidence_lookup'])
    pd.testing.assert_frame_equal(a.drop(columns=['y','hit']),b.drop(columns=['y','hit']))
    assert set(bundle['calibrations'])==set(range(1,25))
    assert all(a.abstain==(a.confidence<a.confidence_threshold))


def test_frozen_backtest_hashes_temporal_splits_and_all_metrics():
    path=Path('experiments/multi_horizon_v1_index.json');index=json.loads(path.read_text())
    assert index['plan_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v1_plan.json').read_bytes()).hexdigest()
    assert not index['parameters_retuned'] and not index['legacy_model_changed']
    frames=[]
    for item in index['rows']:
        start=pd.Timestamp(item['month']+'-01',tz='UTC')
        assert pd.Timestamp(item['train_target_end'])<pd.Timestamp(item['scale_target_end'])<pd.Timestamp(item['cq_target_end'])<start
        assert pd.Timestamp(item['confidence_validation_target_end'])<start
        for name,key in [('artifact','artifact_sha256'),('predictions','predictions_sha256')]:
            assert hashlib.sha256(Path(item[name]).read_bytes()).hexdigest()==item[key]
        d=pd.read_csv(item['predictions']);assert len(d)==24*pd.Period(item['month']).days_in_month*24
        assert np.all(d.lower<=d.point) and np.all(d.point<=d.upper)
        assert np.all(d.abstain==(d.confidence<d.confidence_threshold));frames.append(d)
    all_rows=pd.concat(frames,ignore_index=True)
    assert len(all_rows)==8760*24
    for m in index['metrics']:
        computed=summarize(all_rows[all_rows.horizon.eq(m['horizon'])])
        for key,value in computed.items():assert value==pytest.approx(m[key],abs=1e-9)
        assert m['n']==8760-m['horizon']


def test_forecast_contract_sources_midnight_rollover_and_conservation():
    index=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text());caches={}
    raw=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron']).set_index('timestamp').Hog_office_Byron
    daily=json.loads(Path('experiments/round78_calibration.json').read_text())
    for item in daily['rows']:
        assert hashlib.sha256(Path(item['multi_path']).read_bytes()).hexdigest()==item['multi_sha256']
        d=pd.read_csv(item['multi_path']);d['wall']=pd.to_datetime(d.origin,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');caches[item['month']]=d.set_index(['wall','horizon'])
    for scenario in ['normal','peak','abstain']:
        d=load_replay(scenario)
        assert d['schema_version']=='1.5' and 'previous_hours' not in d
        assert d['meta']['multi_horizon_model_version']==index['version'] and d['meta']['floor_uses']==USES
        for row in d['hours']:
            origin=datetime.fromisoformat(row['t']);predictions=row['forecast_24h'];assert len(predictions)==24
            assert [p['horizon'] for p in predictions]==list(range(1,25))
            for recent,offset in zip(row['recent_actual'],[-1,0]):
                t=origin+timedelta(hours=offset);assert recent['t']==t.isoformat()
                assert recent['actual_kw']==round(float(raw.loc[t.strftime('%Y-%m-%d %H:%M:%S')]),1)
            assert row['recent_actual'][-1]['actual_kw']==row['actual_kw']
            assert row['floors_kw']==floors(row['point_kw'],origin.hour,row['t'][:10])
            for p in predictions:
                t=origin+timedelta(hours=p['horizon']);assert p['t']==t.isoformat()
                cached=caches[origin.strftime('%Y-%m')].loc[(origin.strftime('%Y-%m-%d %H:%M:%S'),p['horizon'])]
                for key in ['point','lower','upper']:assert p[key+'_kw']==round(float(cached[key]),1)
                assert p['confidence']==pytest.approx(cached.confidence,abs=1e-12) and p['abstain']==bool(cached.abstain)
                assert p['abstain']==(p['confidence']<p['confidence_threshold'])
                assert p['lower_kw']<=p['point_kw']<=p['upper_kw']
                assert p['floors_kw']==floors(p['point_kw'],t.hour,t.strftime('%Y-%m-%d'))
                assert sum(round(v*10) for v in p['floors_kw'])==round(p['point_kw']*10)
                assert len(set(p['floors_kw']))>1
        office=[i for i,u in enumerate(USES) if u=='office']
        night=[np.mean(np.array(h['floors_kw'])[office]) for h in d['hours'] if int(h['t'][11:13]) in (0,1,2,3,4,5,22,23)]
        day=[np.mean(np.array(h['floors_kw'])[office]) for h in d['hours'] if 10<=int(h['t'][11:13])<18]
        assert np.mean(night)<np.mean(day)


def test_future_export_receipt_hashes_and_no_network():
    r=json.loads(Path('experiments/future24_export.json').read_text())
    assert r['schema_version']=='1.4' and r['new_llm_calls']==0 and r['agent_records_preserved']
    index=json.loads(Path('experiments/multi_horizon_v1_index.json').read_text())
    index=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text())
    card=json.loads(Path('exports/model_card.json').read_text(encoding='utf-8'))['multi_horizon']
    assert card['coverage_target_met_any_horizon']==any(m['retained_coverage']>=.905 for m in index['metrics'])
    assert not card['live_multi_step_POST_implemented']
    assert card['model_version']==index['version']
    daily=json.loads(Path('experiments/round78_calibration.json').read_text())
    for expected,metric in zip(card['metrics_by_horizon'],daily['multi_metrics']):
        assert all(metric[k]==v for k,v in expected.items())
    assert r['index_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v3_index.json').read_bytes()).hexdigest()
    for p,sha in index['code_sha256'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==sha
    for name,sha in r['export_sha256'].items():assert hashlib.sha256(Path('exports/replay',name).read_bytes()).hexdigest()==sha
