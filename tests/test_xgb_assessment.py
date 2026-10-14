"""Audit the saved experiment receipt without requiring optional model dependencies."""
import hashlib
import json
from pathlib import Path
import pandas as pd
import pytest
from src.conformal.replay_calibration import summary


def test_xgb_final_receipt():
    report=Path('experiments/xgb_final_assessment.json')
    result=json.loads(report.read_text(encoding='utf-8'))
    assert result['champion_updated'] is False
    assert result['replay_updated'] is False
    assert result['coverage_pass'] is False
    plan=Path('experiments/xgb_final_plan.json')
    assert hashlib.sha256(plan.read_bytes()).hexdigest()==result['plan_sha256']
    paths=[Path(result['artifact']),Path('data/byron2017.csv')]
    if not all(p.exists() for p in paths):
        pytest.skip('Local experiment artifact and data are not distributed in Git')
    assert hashlib.sha256(paths[0].read_bytes()).hexdigest()==result['artifact_sha256']
    assert hashlib.sha256(paths[1].read_bytes()).hexdigest()==result['data_sha256']
    for row in result['rows']:
        name=row['model'];path=Path(f'data/byron_final_{name}_rho15.csv')
        assert hashlib.sha256(path.read_bytes()).hexdigest()==result['prediction_sha256'][name]
        actual=summary(pd.read_csv(path))
        for key,value in actual.items():
            assert value==pytest.approx(row['fixed_gate'][key])
