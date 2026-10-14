"""Held-building test: global point/scale frozen, local calibration only."""
import argparse
import json
import pandas as pd
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.models.base import ForecastResult
from src.metrics import evaluate


def run(path, target_building, settings='configs/baseline.yaml'):
    cfg = config(settings)
    frame = adapt(pd.read_csv(path), cfg)
    times = sorted(frame.timestamp.unique())
    a, b = int(len(times) * .65), int(len(times) * .85)
    source = frame[frame.building_id != target_building]
    target = frame[frame.building_id == target_building]
    if source.empty or target.empty:
        raise ValueError('need disjoint source and target buildings')
    train = source[source.timestamp.isin(times[:a])]
    cal = source[source.timestamp.isin(times[a:b])]
    model = ResidualForecaster(cfg).fit(train, cal)
    # Transfer context: first calibration hours may use the target's earlier
    # observations but never fit the point/scale model or inspect target test labels.
    target_cal = target[target.timestamp.isin(times[a:b])]
    if target_cal.empty:
        raise ValueError('target has no local calibration observations')
    point_before = model.point_model.booster_.model_to_string()
    scale_before = model.scale_model.booster_.model_to_string()
    model.recalibrate(target_cal)
    assert model.point_model.booster_.model_to_string() == point_before
    assert model.scale_model.booster_.model_to_string() == scale_before
    # Historical backtest only: lag at each target hour uses a measured previous hour.
    prediction = model.predict(target).frame
    prediction = prediction[prediction.timestamp.isin(times[b:])].reset_index(drop=True)
    truth = target.merge(prediction[['building_id','timestamp']], on=['building_id','timestamp'])
    return {'target_building': target_building, 'source_buildings': source.building_id.nunique(),
            'local_calibration_rows': len(target_cal),
            'metrics': evaluate(truth.y, ForecastResult(prediction)),
            'claim': 'historical one-step transfer, not a live or independent-site guarantee'}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('csv')
    p.add_argument('--target-building', required=True)
    args = p.parse_args()
    print(json.dumps(run(args.csv, args.target_building), indent=2))
