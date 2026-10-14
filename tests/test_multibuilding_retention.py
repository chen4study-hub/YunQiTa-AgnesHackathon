"""Every improving intermediate has a source-bound local bundle and prediction cache."""
import hashlib
import json
from pathlib import Path
import pandas as pd
import pytest


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.mark.parametrize('stem',['multibuilding_ood','multibuilding_pointonly'])
def test_retained_improvements_and_receipts(stem):
    result=json.loads(Path(f'experiments/{stem}_results.json').read_text(encoding='utf-8'))
    assert result['completed_comparisons']==36
    assert not result['failures']
    assert result['final_test_evaluated'] is False
    expected={(r['building'],r['fold']) for r in result['rows'] if any(g>1e-10 for g in r['composite_gain'].values())}
    retained={(r['building'],r['fold']) for r in result['intermediates']}
    assert expected==retained
    assert result['plan_sha256']==sha('experiments/multibuilding_ood_plan.json')
    for item in result['intermediates']:
        artifact=Path(item['artifact']);cache=Path(item['predictions'])
        if not artifact.exists() or not cache.exists():
            pytest.skip('Local model/cache artifacts are not distributed in Git')
        assert sha(artifact)==item['artifact_sha256']
        assert sha(cache)==item['predictions_sha256']
        pred=pd.read_csv(cache)
        assert pred.groupby('method').size().to_dict()=={'baseline':876,'weather_ood':876}
        if stem=='multibuilding_pointonly':
            a=pred[pred.method.eq('baseline')].reset_index(drop=True)
            b=pred[pred.method.eq('weather_ood')].reset_index(drop=True)
            pd.testing.assert_frame_equal(a[['lower','upper','abstain','risk_score','hit']],
                                          b[['lower','upper','abstain','risk_score','hit']])
            assert (b.point>=b.lower).all() and (b.point<=b.upper).all()
