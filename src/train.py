"""Train on explicitly supplied observed CSV; no synthetic scores in production registry."""
import argparse
import json
import time
from pathlib import Path
import pandas as pd
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.models.base import ForecastResult
from src.metrics import evaluate, risk_coverage
from src.features.build import build
import numpy as np
from scipy.stats import binomtest


def run(csv, config_path='configs/baseline.yaml', artifact='models/paper-inspired-v1.joblib'):
    started = time.monotonic()
    cfg = config(config_path)
    frame = adapt(pd.read_csv(csv), cfg)
    times = sorted(frame.timestamp.unique())
    if len(times) < 300:
        raise ValueError('at least 300 observed hours required')
    a, b = int(len(times) * .65), int(len(times) * .85)
    # Separate chronological pilot validation; the final test is touched once.
    p, q = int(len(times) * .45), int(len(times) * .55)
    pilot_train = frame[frame.timestamp.isin(times[:p])]
    pilot_calib = frame[frame.timestamp.isin(times[p:q])]
    pilot = ResidualForecaster(cfg).fit(pilot_train, pilot_calib)
    val_context = frame[frame.timestamp.isin(times[:a])]
    vp = pilot.predict(val_context).frame
    vp = vp[vp.timestamp.isin(times[q:a])].sort_values(['building_id','timestamp']).reset_index(drop=True)
    vy = frame.merge(vp[['building_id','timestamp']], on=['building_id','timestamp'])
    vy = vy.sort_values(['building_id','timestamp']).reset_index(drop=True)
    validation = evaluate(vy.y.to_numpy(), ForecastResult(vp))
    feature_rows, _ = build(val_context, cfg)
    lag = feature_rows.merge(vp[['building_id', 'timestamp']], on=['building_id', 'timestamp'])
    lag = lag.sort_values(['building_id', 'timestamp']).reset_index(drop=True)
    persistence = float(np.sqrt(np.mean((vy.y.to_numpy() - lag.lag_1.to_numpy()) ** 2)))
    retained = ~vp.abstain.to_numpy(dtype=bool)
    covered = (vy.y.to_numpy() >= vp.lower.to_numpy()) & (vy.y.to_numpy() <= vp.upper.to_numpy())
    ci = binomtest(int(covered[retained].sum()), int(retained.sum())).proportion_ci(method='exact')
    validation['ci95_exact_iid'] = [float(ci.low), float(ci.high)]
    validation['target_rejection'] = cfg['conformal']['rejection_fraction']
    validation['retained_n'] = int(retained.sum())
    baseline_retained_mae = float(np.mean(np.abs(vy.y.to_numpy()[retained] - lag.lag_1.to_numpy()[retained])))
    nominal = 1 - cfg['conformal']['alpha']
    coverage_ok = bool(validation['retained_picp'] >= nominal or ci.low <= nominal <= ci.high)
    # New contract: bootstrap against persistence on identical retained rows; later
    # champions require same cohort AND actual rejection rate and lower retained MAE.
    eligible = bool(coverage_ok and validation['retained_mae'] < baseline_retained_mae)
    train, calib, test = [frame.loc[frame.timestamp.isin(t)].copy()
                          for t in (times[:a], times[a:b], times[b:])]
    model = ResidualForecaster(cfg).fit(train, calib)
    # Context is observed load only up to t-1; test is historical backtest,
    # not a forward forecast. Labelled test is read ONLY after calibration.
    context = pd.concat([train, calib, test], ignore_index=True)
    predictions = model.predict(context).frame
    predictions = predictions[predictions.timestamp.isin(times[b:])].reset_index(drop=True)
    observed = test.merge(predictions[['building_id', 'timestamp']], on=['building_id', 'timestamp'])
    observed = observed.sort_values(['building_id','timestamp']).reset_index(drop=True)
    predictions = predictions.sort_values(['building_id','timestamp']).reset_index(drop=True)
    metrics = evaluate(observed.y.to_numpy(), ForecastResult(predictions))
    metrics['risk_coverage_curve_gate_rank'] = risk_coverage(observed.y, ForecastResult(predictions))
    destination = Path(artifact)
    if destination.stem != cfg['model']['version']:
        raise ValueError('artifact basename must match model version for API loading')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError('model versions are immutable: use a new version in YAML')
    summary = {'version': cfg['model']['version'], 'status': 'ready', 'metrics': metrics,
               'seed': cfg['seed'], 'config_path': str(config_path), 'elapsed_seconds': time.monotonic() - started,
               'validation': validation, 'baseline_validation_rmse': persistence,
               'baseline_retained_mae_same_rows': baseline_retained_mae,
               'eligible_for_champion': eligible,
               'data_source': str(csv), 'split': {'train_end': str(times[a-1]),
               'calib_end': str(times[b-1]), 'test_end': str(times[-1])}}
    registry = destination.parent / 'registry.json'
    tmp = registry.with_suffix('.tmp')
    previous = json.loads(registry.read_text(encoding='utf-8')) if registry.exists() else {'champion': None, 'models': []}
    if any(m['version'] == summary['version'] for m in previous['models']):
        raise ValueError('model version already registered')
    incumbent = next((m for m in previous['models'] if m['version'] == previous['champion']), None)
    if incumbent and (incumbent.get('validation', {}).get('retained_mae') is None or
                      incumbent.get('split', {}).get('train_end') != summary['split']['train_end'] or
                      incumbent.get('split', {}).get('calib_end') != summary['split']['calib_end'] or
                      incumbent.get('data_source') != summary['data_source']):
        eligible = False  # incompatible cohorts require explicit offline review
    elif incumbent and (abs(validation['rejection_rate'] - incumbent['validation']['rejection_rate']) > 1e-8 or
                        validation['retained_mae'] >= incumbent['validation']['retained_mae']):
        eligible = False  # never obtain promotion by silently accepting fewer hours
    summary['eligible_for_champion'] = eligible
    previous['models'].append(summary)
    previous['champion'] = summary['version'] if eligible else previous['champion']
    model.save(destination)
    tmp.write_text(json.dumps(previous, indent=2), encoding='utf-8')
    tmp.replace(registry)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('csv')
    parser.add_argument('--config', default='configs/baseline.yaml')
    parser.add_argument('--artifact', default='models/paper-inspired-v1.joblib')
    args = parser.parse_args()
    print(json.dumps(run(args.csv, args.config, args.artifact), indent=2))
