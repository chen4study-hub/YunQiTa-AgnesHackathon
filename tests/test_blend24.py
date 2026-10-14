from src.data.replay_payload import load_replay
import json
import hashlib
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import pytest
from scripts.research_blend24 import choose,summary
from scripts.backtest_direct24 import summarize
from src.models.blend_multi import predict,expert_frame
from src.models.shortfix_multi import features,COLUMNS_V2
from tests.test_direct24 import synthetic


def test_frozen_selection_once_final_and_metric_hash_reproduction():
    index=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text());selection=json.loads(Path('experiments/multi_horizon_v3_selection.json').read_text())
    assert choose(selection['summary'])==(index['selected'],index['development_gate_passed'])
    assert index['final_evaluations']==1 and not index['parameters_retuned']
    assert index['plan_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v3_plan.json').read_bytes()).hexdigest()
    assert index['selection_sha256']==hashlib.sha256(Path('experiments/multi_horizon_v3_selection.json').read_bytes()).hexdigest()
    parts=[]
    for row in index['rows']:
        start=pd.Timestamp(row['month']+'-01',tz='UTC')
        assert pd.Timestamp(row['train_target_end'])<pd.Timestamp(row['scale_target_end'])<pd.Timestamp(row['cq_target_end'])<start
        assert pd.Timestamp(row['confidence_validation_target_end'])<start
        for key in ['artifact','predictions']:assert hashlib.sha256(Path(row[key]).read_bytes()).hexdigest()==row[key+'_sha256']
        p=pd.read_csv(row['predictions']);parts.append(p)
        assert np.all(p.abstain==(p.confidence<p.confidence_threshold))
    f=pd.concat(parts,ignore_index=True)
    for m in index['metrics']:
        for k,v in summarize(f[f.horizon.eq(m['horizon'])]).items():assert m[k]==pytest.approx(v)
    for name,s in summary(f).items():
        for k,v in s.items():assert index['seam_after'][name][k]==pytest.approx(v)


def test_blend_inputs_outputs_are_future_causal_and_no_interval_average():
    index=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text());bundle=joblib.load(index['rows'][6]['artifact'])
    data=synthetic();t=data.timestamp.iloc[220];f=features(data);a=f[f.origin.eq(t)]
    changed=data.copy();changed.loc[changed.timestamp>t,['y','air_temperature']]=99999.;g=features(changed);b=g[g.origin.eq(t)]
    for short in [True,False]:pd.testing.assert_frame_equal(expert_frame(a,short)[COLUMNS_V2].reset_index(drop=True),expert_frame(b,short)[COLUMNS_V2].reset_index(drop=True))
    p=predict(bundle,a,bundle['confidence_lookup']);q=predict(bundle,b,bundle['confidence_lookup'])
    pd.testing.assert_frame_equal(p.drop(columns=['y','hit']),q.drop(columns=['y','hit']))
    assert set(bundle['calibrations'])=={3,4,5,6} and bundle['weights']=={'3':.1,'4':.25,'5':.5,'6':.75}
    assert len(p)==23 and np.all(p.lower<=p.point) and np.all(p.point<=p.upper)


def test_h1_remains_original_and_local_seam_improves():
    for scenario in ['normal','peak','abstain']:
        d=load_replay(scenario)
        for a,b in zip(d['hours'],d['hours'][1:]):
            for key in ['point_kw','lower_kw','upper_kw','confidence','abstain']:
                assert a['forecast_24h'][0][key]==pytest.approx(b[key])
    d=load_replay('abstain');p=d['hours'][11]['forecast_24h']
    assert abs(p[3]['point_kw']-p[2]['point_kw'])<207.4
