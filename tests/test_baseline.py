import numpy as np
import pandas as pd
import pytest
from src.conformal.selective import finite_quantile
from src.data.adapter import adapt, config
from src.features.build import build
from src.models.residual import ResidualForecaster
from src.metrics import evaluate


def sample(hours=700):
    rng = np.random.default_rng(42)
    times = pd.date_range('2026-01-01', periods=hours, freq='h', tz='UTC')
    rows = []
    for building in ('A', 'B'):
        y = np.maximum(1, 50 + 8 * np.sin(np.arange(hours) * 2 * np.pi / 24)
                       + (10 if building == 'B' else 0) + rng.normal(0, 1, hours))
        rows.append(pd.DataFrame({'timestamp': times, 'building_id': building,
            'meter_reading': y, 'primary_use': 'office', 'air_temperature': 20 + y * .01}))
    return pd.concat(rows, ignore_index=True)


def test_quantile_and_no_leakage():
    assert finite_quantile([1, 2, 3, 4], 0.25) == 4
    cfg = config()
    df = adapt(sample(180), cfg)
    f, _ = build(df, cfg)
    t = f.loc[f.building_id.eq('A')].iloc[-1].timestamp
    changed = df.copy()
    changed.loc[(changed.building_id == 'A') & (changed.timestamp == t), 'y'] = 1000000
    f2, _ = build(changed, cfg)
    a = f.loc[(f.building_id == 'A') & (f.timestamp == t), 'lag_1'].iloc[0]
    b = f2.loc[(f2.building_id == 'A') & (f2.timestamp == t), 'lag_1'].iloc[0]
    assert a == b
    assert np.array_equal(f.loc[f.timestamp == t, 'disagreement'],
                          f2.loc[f2.timestamp == t, 'disagreement'])


def test_fit_recalibrate_roundtrip(tmp_path):
    cfg = config()
    frame = adapt(sample(1000), cfg)
    times = sorted(frame.timestamp.unique())
    train = frame[frame.timestamp.isin(times[:600])].copy()
    calib = frame[frame.timestamp.isin(times[600:880])].copy()
    model = ResidualForecaster(cfg).fit(train, calib)
    before = model.point_model.booster_.model_to_string()
    model.recalibrate(calib[calib.building_id.eq('B')].copy())
    assert model.point_model.booster_.model_to_string() == before
    path = tmp_path / 'model.joblib'
    model.save(path)
    restored = ResidualForecaster.load(path)
    result = restored.predict(frame).frame
    test = result[result.timestamp.isin(times[880:])].reset_index(drop=True)
    y = frame.merge(test[['building_id','timestamp']], on=['building_id','timestamp'])
    assert test.lower.le(test.point).all() and test.point.le(test.upper).all()
    assert set(test.confidence) == {0.905}
    assert 0 <= evaluate(y.y.to_numpy(), type('P', (), {'frame': test})())['rejection_rate'] <= 1


def test_duplicate_or_gap_rejected():
    cfg = config()
    d = sample(3)
    with pytest.raises(ValueError):
        adapt(pd.concat([d, d.iloc[[0]]]), cfg)
    with pytest.raises(ValueError):
        adapt(d.drop(d.index[1]), cfg)
