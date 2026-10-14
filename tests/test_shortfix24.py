from src.data.replay_payload import load_replay
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import pytest
from scripts.research_shortfix24 import choose
from scripts.backtest_direct24 import summarize
from src.models.shortfix_multi import features,predict,one_step_at,COLUMNS_V2
from tests.test_direct24 import synthetic


def test_latest_features_are_causal_and_do_not_drop_old_lags():
    d=synthetic();origin=d.timestamp.iloc[220];a=features(d);changed=d.copy()
    changed.loc[changed.timestamp>origin,['y','air_temperature']]=999999.
    b=features(changed);a=a[a.origin.eq(origin)];b=b[b.origin.eq(origin)]
    pd.testing.assert_frame_equal(a[COLUMNS_V2].reset_index(drop=True),b[COLUMNS_V2].reset_index(drop=True))
    assert a.latest_23.eq(d.y.iloc[197]).all() and a.latest_167.eq(d.y.iloc[53]).all()
    assert a.load_24.eq(d.y.iloc[196]).all() and a.load_168.eq(d.y.iloc[52]).all()
    assert a[a.horizon.le(3)].anchor.eq(d.y.iloc[220]).all()


def test_h1_causal_reconstruction_and_full_same_month_alignment():
    from scripts.research_holiday_calibration import load_data
    old=json.loads(Path('experiments/demo_monthly_index.json').read_text());data=load_data()
    row=next(r for r in old['rows'] if r['month']=='2017-07');bundle=joblib.load(row['artifact'])
    origin=pd.Timestamp('2017-07-20 15:00',tz='UTC');a=one_step_at(data,pd.Series([origin]),bundle)
    changed=data.copy();changed.loc[changed.timestamp>origin,['y','air_temperature']]=999999.
    b=one_step_at(changed,pd.Series([origin]),bundle)
    for key in ['point','lower','upper','scale','risk_score','abstain','confidence']:
        assert a[key].iloc[0]==b[key].iloc[0]
    idx=json.loads(Path('experiments/multi_horizon_v2_index.json').read_text())
    for item in idx['rows']:
        pred=pd.read_csv(item['predictions']);pred=pred[pred.horizon.eq(1)].copy();pred['target']=pd.to_datetime(pred.target,utc=True)
        orig=next(r for r in old['rows'] if r['month']==item['month']);cache=pd.read_csv(orig['predictions']);cache['timestamp']=pd.to_datetime(cache.timestamp,utc=True)
        same=pred.merge(cache,left_on='target',right_on='timestamp',suffixes=('_v2','_old'),validate='one_to_one')
        for key in ['point','lower','upper','risk_score','abstain']:
            np.testing.assert_allclose(same[key+'_v2'],same[key+'_old'],rtol=0,atol=1e-8)
        assert len(same)==len(pred)-1
    for scenario in ['normal','peak','abstain']:
        d=load_replay(scenario)
        for current,next_row in zip(d['hours'],d['hours'][1:]):
            h1=current['forecast_24h'][0]
            for key in ['t','point_kw','lower_kw','upper_kw','confidence','risk_score','risk_threshold','abstain']:
                assert h1[key]==next_row[key] or (key=='confidence' and h1[key]==pytest.approx(next_row[key],abs=1e-12))


def test_frozen_selection_hashes_once_final_metrics_and_prior_splits():
    plan=json.loads(Path('experiments/multi_horizon_v2_plan.json').read_text(encoding='utf-8'))
    selected=json.loads(Path('experiments/multi_horizon_v2_selection.json').read_text())
    index=json.loads(Path('experiments/multi_horizon_v2_index.json').read_text())
    assert choose(selected['summary'],plan)==(selected['selected'],selected['development_gate_passed'])
    assert index['selected']==selected['selected'] and index['final_evaluations']==1 and not index['parameters_retuned']
    assert index['plan_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v2_plan.json').read_bytes()).hexdigest()
    assert index['selection_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v2_selection.json').read_bytes()).hexdigest()
    frames=[]
    for r in index['rows']:
        start=pd.Timestamp(r['month']+'-01',tz='UTC')
        assert pd.Timestamp(r['train_target_end'])<pd.Timestamp(r['scale_target_end'])<pd.Timestamp(r['cq_target_end'])<start
        assert pd.Timestamp(r['confidence_validation_target_end'])<start
        assert pd.Timestamp(r['h1_confidence_validation_target_end'])<start
        for key in ['artifact','predictions']:assert hashlib.sha256(Path(r[key]).read_bytes()).hexdigest()==r[key+'_sha256']
        d=pd.read_csv(r['predictions']);frames.append(d)
        assert len(d)==24*24*pd.Period(r['month']).days_in_month
        assert np.all(d.abstain==(d.confidence<d.confidence_threshold))
    all_rows=pd.concat(frames,ignore_index=True)
    for metric in index['metrics']:
        computed=summarize(all_rows[all_rows.horizon.eq(metric['horizon'])])
        assert metric['n']==8760-metric['horizon']
        for k,v in computed.items():assert v==pytest.approx(metric[k])


def test_segmented_prediction_ignores_future_labels():
    index=json.loads(Path('experiments/multi_horizon_v2_index.json').read_text());bundle=joblib.load(index['rows'][6]['artifact'])
    f=features(synthetic());f=f[f.origin.eq(f.origin.max())];a=predict(bundle,f,bundle['confidence_lookup'])
    f=f.copy();f['y']=999999.;b=predict(bundle,f,bundle['confidence_lookup'])
    pd.testing.assert_frame_equal(a.drop(columns=['y','hit']),b.drop(columns=['y','hit']))
    assert len(a)==23 and set(a.horizon)==set(range(2,25))
