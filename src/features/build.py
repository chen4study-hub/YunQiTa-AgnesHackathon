"""Build issue-time-available 1-step features; never consume target-hour load."""
import numpy as np
import pandas as pd


def build(frame: pd.DataFrame, cfg: dict):
    f = frame.copy().sort_values(['building_id', 'timestamp']).reset_index(drop=True)
    f['hour'] = f.timestamp.dt.hour
    f['weekday'] = f.timestamp.dt.dayofweek
    f['month'] = f.timestamp.dt.month
    f['weekend'] = (f.weekday >= 5).astype(int)
    f['holiday'] = f.timestamp.dt.strftime('%Y-%m-%d').isin(cfg['features'].get('holidays', [])).astype(int)
    cols = ['hour', 'weekday', 'month', 'weekend', 'holiday']
    groups = f.groupby('building_id', sort=False)['y']
    for lag in cfg['features']['lags']:
        col = f'lag_{lag}'
        f[col] = groups.shift(lag)
        cols.append(col)
    for window in cfg['features']['rolling_windows']:
        col = f'roll_{window}'
        f[col] = f.groupby('building_id', sort=False)['y'].transform(
            lambda s: s.shift(1).rolling(window, min_periods=window).mean())
        cols.append(col)
    # Observed site weather must be lagged, past-filled only, never backfilled.
    for weather in cfg['features'].get('weather', []):
        if weather in f:
            col = f'{weather}_past'
            f[col] = f.groupby('building_id', sort=False)[weather].transform(
                lambda s: pd.to_numeric(s, errors='coerce').ffill().shift(1))
            cols.append(col)
    f['disagreement'] = (f['lag_1'] - f['lag_24']).abs()
    # LightGBM handles missing weather, but unknown load lag is not a prediction.
    f = f.dropna(subset=[f'lag_{lag}' for lag in cfg['features']['lags']]).copy()
    return f, cols
