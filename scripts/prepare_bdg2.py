"""Create a small real BDG2 2016 hourly cohort for the shadow MVP.

No imputation of meter values. Require complete hourly load; weather is joined by site
and timestamp and subsequently past-filled/shifted inside the feature module.
"""
import argparse
from pathlib import Path
import pandas as pd


def prepare(root: Path, out: Path, max_buildings: int = 6):
    meta = pd.read_csv(root / 'metadata.csv')
    header = pd.read_csv(root / 'electricity_cleaned.csv', nrows=0).columns
    eligible = meta[(meta.electricity.astype(str).str.lower() == 'yes') &
                    (~meta.primaryspaceusage.fillna('').str.contains('parking', case=False)) &
                    (meta.building_id.isin(header))].copy()
    matrix = pd.read_csv(root / 'electricity_cleaned.csv',
                         usecols=['timestamp'] + eligible.building_id.tolist())
    matrix = matrix[matrix.timestamp.str.startswith('2016-')].copy()
    completeness = matrix[eligible.building_id].notna().mean()
    # Deterministic first IDs by site, with both sites and distinct uses represented.
    eligible = eligible[eligible.building_id.isin(completeness[completeness == 1].index)]
    eligible = eligible[eligible.site_id.isin(['Hog', 'Robin'])].sort_values(['site_id', 'building_id'])
    ids = eligible.groupby('site_id', group_keys=False).head(max(1, max_buildings // 2)).building_id.tolist()
    if len(ids) < 2 or len(matrix) < 8760:
        raise ValueError('not enough complete hourly BDG2 buildings')
    long = matrix[['timestamp'] + ids].melt(id_vars='timestamp', var_name='building_id', value_name='meter_reading')
    long = long.merge(eligible[['building_id', 'site_id', 'primaryspaceusage']], on='building_id', validate='many_to_one')
    weather = pd.read_csv(root / 'weather.csv', usecols=['timestamp','site_id','airTemperature'])
    weather = weather[weather.timestamp.str.startswith('2016-')]
    if weather.duplicated(['site_id','timestamp']).any():
        raise ValueError('duplicate weather site-hours')
    long = long.merge(weather, on=['site_id', 'timestamp'], how='left', validate='many_to_one')
    long = long.rename(columns={'primaryspaceusage': 'primary_use', 'airTemperature': 'air_temperature'})
    long['timestamp'] = pd.to_datetime(long.timestamp, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    long = long.sort_values(['building_id','timestamp'])
    out.parent.mkdir(parents=True, exist_ok=True)
    long.to_csv(out, index=False)
    return {'rows': len(long), 'buildings': ids, 'sites': sorted(long.site_id.unique()),
            'weather_missing': int(long.air_temperature.isna().sum()),
            'timestamp_assumption': 'raw naive site timestamps relabeled UTC for demo; real timezone alignment pending'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('data/raw/bdg2'))
    parser.add_argument('--out', type=Path, default=Path('data/bdg2_cohort.csv'))
    parser.add_argument('--max-buildings', type=int, default=6)
    args = parser.parse_args()
    print(prepare(args.root, args.out, args.max_buildings))
