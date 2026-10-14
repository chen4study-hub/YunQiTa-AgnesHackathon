import numpy as np
import pandas as pd
from src.transfer import run
from tests.test_baseline import sample


def test_transfer_smoke(tmp_path):
    f = sample(1000)
    csv = tmp_path / 'toy.csv'
    f.to_csv(csv, index=False)
    result = run(csv, 'B')
    assert result['source_buildings'] == 1
    assert result['local_calibration_rows'] == 200
    assert 0 <= result['metrics']['retained_picp'] <= 1
