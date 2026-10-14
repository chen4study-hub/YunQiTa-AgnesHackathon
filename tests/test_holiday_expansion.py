import hashlib
import json
from pathlib import Path
import pandas as pd
import pytest


def test_holiday_expansion_ablation_and_preservation():
    d=json.loads(Path('experiments/holiday_expansion_results.json').read_text(encoding='utf-8'))
    assert len(d['rows'])==12
    assert not d['final_test_evaluated'] and not d['champion_updated'] and not d['replay_updated']
    for fold in (1,2,3):
        rows={r['variant']:r for r in d['rows'] if r['fold']==fold}
        assert rows['expanded_holiday_flag']['training_holiday_days']>rows['2017_only_holiday_flag']['training_holiday_days']
        assert rows['expanded_holiday_flag']['holiday']['n']==rows['2017_only_no_calendar']['holiday']['n']==24
    expected={(r['fold'],r['variant']) for r in d['rows'] if r['variant']!='2017_only_no_calendar' and
        (any(g>1e-10 for g in r['composite_gain'].values()) or r['holiday_mae_gain']>1e-10)}
    assert expected=={(r['fold'],r['variant']) for r in d['intermediates']}
    clean=Path(d['clean_data'])
    if not clean.exists():pytest.skip('Local historical dataset not distributed')
    assert hashlib.sha256(clean.read_bytes()).hexdigest()==d['clean_data_sha256']
    f=pd.read_csv(clean)
    assert not f.y.isna().any() and not f.duplicated(['timestamp','building_id']).any()
    for item in d['intermediates']:
        for field in ('artifact','predictions'):
            p=Path(item[field])
            assert p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==item[field+'_sha256']
