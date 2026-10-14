import json
from pathlib import Path


def test_may_diagnosis_keeps_negative_findings():
    d=json.loads(Path('experiments/may_diagnosis.json').read_text(encoding='utf-8'))
    assert set(d)=={'replay_lgb_cqr','expanded_holiday_lgb_cqr','xgb_static'}
    assert all(r['missing_actual']==0 for r in d.values())
    assert d['xgb_static']['mae']>d['xgb_static']['persistence_mae']
    assert d['expanded_holiday_lgb_cqr']['worst_days']['2017-05-09']['mae']>d['replay_lgb_cqr']['worst_days']['2017-05-09']['mae']
