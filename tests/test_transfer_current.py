import copy
import json
from pathlib import Path
import numpy as np
import pandas as pd
import pytest
from scripts.evaluate_transfer_current import (ROOT, VERSION, select_calibration,
    predict_protocol, measured, model_card_transfer_fields, sha)
from src.features.build import build
from src.conformal.daily_local import prepare

CFG = dict(risk_weights=[.7, .15, .1, .05], rejection_fraction=.15,
           alpha=.095, max_relative_width=1.)
LOOKUP = dict(centers=[.05, .95], coverage=[.95, .8])


def sample():
    rng = np.random.default_rng(4)
    n = 18*24
    f = pd.DataFrame(dict(timestamp=pd.date_range('2017-02-01', periods=n, freq='h', tz='UTC'),
        building_id='Hog_office_Alexis', y=100+rng.normal(0, 8, n), point=100.,
        raw_low=94., raw_high=106., holiday=False))
    for i in range(4):
        f[f'risk_{i}'] = rng.uniform(0, 1, n)
    plan = dict(time=dict(test_start='2017-02-11T00:00:00Z'),
                calibration_days=10, minimum_calibration_rows=120)
    return f, plan


def test_primary_calibration_never_consults_test_labels():
    f, plan = sample()
    start = pd.Timestamp(plan['time']['test_start'])
    end = f.timestamp.max().floor('D')+pd.Timedelta(days=1)
    other = f.copy()
    other.loc[other.timestamp >= start, 'y'] = 1e9
    a = predict_protocol(f, start, end, CFG, LOOKUP, plan, 'early_only')
    b = predict_protocol(other, start, end, CFG, LOOKUP, plan, 'early_only')
    cols = [c for c in a if c not in ('y', 'hit')]
    pd.testing.assert_frame_equal(a[cols], b[cols])
    assert (a.cal_end < start).all() and a.cal_n.eq(240).all()
    # A whole mutated day must not change its own daily decision; yesterday may affect tomorrow.
    day = start+pd.Timedelta(days=2)
    online_other = f.copy()
    online_other.loc[online_other.timestamp >= day, 'y'] = 1e9
    c = predict_protocol(f, start, end, CFG, LOOKUP, plan, 'daily_past10')
    d = predict_protocol(online_other, start, end, CFG, LOOKUP, plan, 'daily_past10')
    same = c.timestamp < day+pd.Timedelta(days=1)
    pd.testing.assert_frame_equal(c.loc[same, cols], d.loc[same, cols])
    assert (c.cal_end < c.timestamp.dt.floor('D')).all()
    assert c.q.iloc[-1] != d.q.iloc[-1]


def test_short_history_and_unknown_policy_fail_closed():
    f, plan = sample()
    with pytest.raises(ValueError):
        select_calibration(f.iloc[:24], f.timestamp.iloc[240], plan, 'early_only')
    with pytest.raises(ValueError):
        select_calibration(f, f.timestamp.iloc[240], plan, 'unknown')


def test_real_source_features_and_decisions_ignore_target_and_future():
    import joblib
    bundle = joblib.load('models/byron-expanded-holiday-monthly-v1-2017-02.joblib')
    cfg = bundle['backbone'].cfg
    n = 500
    f = pd.DataFrame(dict(timestamp=pd.date_range('2017-01-01', periods=n, freq='h', tz='UTC'),
        building_id='Hog_office_Alexis', usage='Office',
        y=100+10*np.sin(np.arange(n)/24), air_temperature=20.))
    cutoff = f.timestamp.iloc[480]
    other = f.copy()
    other.loc[other.timestamp >= cutoff, ['y', 'air_temperature']] = 1e9
    a, columns = build(f, cfg)
    b, _ = build(other, cfg)
    pd.testing.assert_frame_equal(a.loc[a.timestamp <= cutoff, columns], b.loc[b.timestamp <= cutoff, columns])
    pa = prepare(bundle['backbone'], f, bundle['quantile_models'])
    pb = prepare(bundle['backbone'], other, bundle['quantile_models'])
    cols = ['point', 'scale', 'raw_low', 'raw_high']+[f'risk_{i}' for i in range(4)]
    pd.testing.assert_frame_equal(pa.loc[pa.timestamp <= cutoff, cols], pb.loc[pb.timestamp <= cutoff, cols])


def test_cv_rmse_denominator_and_empty_retained():
    f, plan = sample()
    start = pd.Timestamp(plan['time']['test_start'])
    p = predict_protocol(f, start, start+pd.Timedelta(days=1), CFG, LOOKUP, plan, 'early_only')
    m = measured(p)
    assert np.isclose(m['cv_rmse'], np.sqrt(np.mean((p.y-p.point)**2))/p.y.mean())
    p['abstain'] = True
    assert measured(p)['retained_coverage'] is None and measured(p)['retained_mae'] is None
    p['y'] = 0.
    assert measured(p)['cv_rmse'] is None


def test_result_counts_integrity_and_card_semantics():
    if not (ROOT/'results.json').exists():
        pytest.skip('evaluation not run yet')
    r = json.loads((ROOT/'results.json').read_text(encoding='utf-8'))
    plan = json.loads((ROOT/'plan.json').read_text(encoding='utf-8'))
    assert r['source_version'] == VERSION
    assert r['selected_buildings'] == [b['building_id'] for b in plan['buildings']]
    assert len(r['source_artifacts']) == 11 and len(r['per_building']) == 20
    assert r['unchanged_estimators'] and r['no_future_calibration'] and r['early_only_no_test_labels']
    assert sha(ROOT/'plan.json') == r['provenance']['plan_sha256']
    assert sha(ROOT/'predictions.csv.gz') == r['predictions_sha256']
    p = pd.read_csv(ROOT/'predictions.csv.gz', parse_dates=['timestamp', 'cal_end'])
    assert not p.duplicated(['building_id', 'model', 'protocol', 'timestamp']).any()
    test_start = pd.Timestamp(plan['time']['test_start'])
    assert (p.cal_end < p.timestamp.dt.floor('D')).all()
    assert (p.loc[p.protocol.eq('early_only'), 'cal_end'] < test_start).all()
    assert p.cal_n.eq(240).all()
    assert (p.abstain == (p.risk_rejected | p.width_rejected)).all()
    assert (p.abstain == (p.confidence < p.confidence_threshold)).all()
    for row in r['per_building']:
        one = p[p.building_id.eq(row['building_id']) & p.model.eq(row['model']) & p.protocol.eq(row['protocol'])]
        assert len(one) == row['n'] == 7680
        m = measured(one)
        for key, value in m.items():
            if value is None:
                assert row[key] is None
            else:
                assert np.isclose(row[key], value)
    for protocol in ('early_only', 'daily_past10'):
        for name in ('transfer', 'self_trained'):
            rows = [x for x in r['per_building'] if x['model'] == name and x['protocol'] == protocol]
            m = r['pooled'][protocol][name]
            assert m['n'] == sum(x['n'] for x in rows)
            assert np.isclose(m['retained_coverage'], sum(x['retained_covered_n'] for x in rows)/sum(x['retained_n'] for x in rows))
    card = model_card_transfer_fields(VERSION)
    assert card['cross_building_coverage'] == r['pooled']['early_only']['transfer']['retained_coverage']
    assert model_card_transfer_fields('old-robin') == {}


def test_exported_model_card_matches_receipt():
    if not (ROOT/'results.json').exists():
        pytest.skip('evaluation not run yet')
    card = json.loads(Path('exports/model_card.json').read_text(encoding='utf-8'))
    fields = model_card_transfer_fields(card['model_version'])
    for key, value in fields.items():
        assert card[key] == value
    assert card['multi_horizon']['cross_building_coverage'] is None
