"""Column mapping, normalization, and strict hourly chronology."""
from pathlib import Path
import pandas as pd
import yaml


def config(path='configs/baseline.yaml'):
    return yaml.safe_load(Path(path).read_text(encoding='utf-8'))


def adapt(frame: pd.DataFrame, settings: dict) -> pd.DataFrame:
    mapping = settings['data']['columns']
    mandatory = ('timestamp', 'building_id', 'target')
    missing = [mapping[k] for k in mandatory if mapping[k] not in frame]
    if missing:
        raise ValueError(f'missing columns: {missing}')
    rename = {source: ('y' if key == 'target' else key)
              for key, source in mapping.items() if source in frame}
    if len(rename) != len(set(rename)):
        raise ValueError('ambiguous column mapping')
    out = frame.rename(columns=rename).copy()
    out['timestamp'] = pd.to_datetime(out['timestamp'], utc=True, errors='raise')
    out['building_id'] = out['building_id'].astype(str)
    out['y'] = pd.to_numeric(out['y'], errors='coerce')
    if 'usage' not in out:
        out['usage'] = 'unknown'
    out['usage'] = out['usage'].fillna('unknown').astype(str)
    out = out.sort_values(['building_id', 'timestamp']).reset_index(drop=True)
    if out.duplicated(['building_id', 'timestamp']).any():
        raise ValueError('duplicate building-hour records')
    if out['y'].dropna().lt(0).any():
        raise ValueError('negative energy use')
    for _, group in out.groupby('building_id'):
        if len(group) > 1 and not (group['timestamp'].diff().dropna() == pd.Timedelta(hours=1)).all():
            raise ValueError('input must be contiguous hourly observations; no silent interpolation')
    return out
