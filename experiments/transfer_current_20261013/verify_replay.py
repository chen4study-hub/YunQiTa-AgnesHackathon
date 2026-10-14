"""Independent second deterministic replay; read-only against saved predictions."""
import copy
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scripts.evaluate_transfer_current import (ROOT, PROTOCOLS, sha, single_thread,
    estimator_hash, validate_data, predict_protocol, measured)
from src.data.adapter import adapt
from src.models.residual import ResidualForecaster
from src.conformal.daily_local import prepare
from scripts.search_byron import fit_quantiles


def main():
    plan = json.loads((ROOT/'plan.json').read_text(encoding='utf-8'))
    result = json.loads((ROOT/'results.json').read_text(encoding='utf-8'))
    index = json.loads(Path(plan['source_index']).read_text(encoding='utf-8'))
    assert sha(ROOT/'plan.json') == result['provenance']['plan_sha256']
    assert sha(plan['data']) == result['provenance']['data_sha256']
    assert sha(plan['source_index']) == result['provenance']['source_index_sha256']
    assert sha('scripts/evaluate_transfer_current.py') == result['provenance']['script_sha256']
    assert sha(ROOT/'predictions.csv.gz') == result['predictions_sha256']
    selected = [b['building_id'] for b in plan['buildings']]
    raw = pd.read_csv(plan['data'])
    metadata = raw[['building_id', 'primary_use']].drop_duplicates()
    for item in plan['buildings']:
        available = metadata[metadata.primary_use.eq(item['usage']) & ~metadata.building_id.eq('Hog_office_Byron')]
        assert sorted(available.building_id)[0] == item['building_id']
    first = index['rows'][0]
    assert sha(first['artifact']) == first['artifact_sha256']
    cfg = copy.deepcopy(joblib.load(first['artifact'])['backbone'].cfg)
    cfg['conformal']['rejection_fraction'] = plan['rejection_fraction']
    data = adapt(raw[raw.building_id.isin(selected)], cfg)
    validate_data(data, plan)
    t = {k: pd.Timestamp(v) for k, v in plan['time'].items()}
    baseline = {}
    for building in selected:
        one = data[data.building_id.eq(building)].copy()
        train = one[one.timestamp < t['self_train_end_exclusive']]
        scale = one[(one.timestamp >= t['self_train_end_exclusive']) & (one.timestamp < t['self_scale_end_exclusive'])]
        model = ResidualForecaster(copy.deepcopy(cfg)).fit(train, scale)
        q = fit_quantiles(model, train)
        single_thread(model, q)
        saved = next(row for row in result['self_fits'] if row['building_id'] == building)
        assert estimator_hash(model, q) == saved['estimator_sha256']
        baseline[building] = prepare(model, one, q)
    old = pd.read_csv(ROOT/'predictions.csv.gz')
    compare_cols = ['point', 'lower', 'upper', 'risk_score', 'threshold', 'q', 'confidence',
                    'confidence_threshold', 'y', 'cal_n', 'cal_kept_n']
    count = 0
    max_error = 0.
    for item in index['rows']:
        month_start = pd.Timestamp(item['month']+'-01', tz='UTC')
        start = max(month_start, t['test_start'])
        end = min(month_start+pd.offsets.MonthBegin(1), t['end_exclusive'])
        if start >= end:
            continue
        assert sha(item['artifact']) == item['artifact_sha256']
        bundle = joblib.load(item['artifact'])
        model, q = bundle['backbone'], bundle['quantile_models']
        single_thread(model, q)
        frozen = estimator_hash(model, q)
        for building in selected:
            one = data[data.building_id.eq(building) & (data.timestamp < end)]
            for name, frame in {'transfer': prepare(model, one, q), 'self_trained': baseline[building]}.items():
                for protocol in PROTOCOLS:
                    new = predict_protocol(frame, start, end, cfg['conformal'], bundle['confidence_lookup'], plan, protocol)
                    prior = old[old.building_id.eq(building) & old.model.eq(name) & old.protocol.eq(protocol) & old.timestamp.str.startswith(item['month'])]
                    prior = prior.sort_values('timestamp').reset_index(drop=True)
                    new = new.sort_values('timestamp').reset_index(drop=True)
                    assert len(new) == len(prior)
                    assert list(pd.to_datetime(prior.timestamp, utc=True)) == list(new.timestamp)
                    for col in compare_cols:
                        np.testing.assert_allclose(new[col], prior[col], rtol=1e-12, atol=1e-10)
                        max_error = max(max_error, float(np.max(np.abs(new[col].to_numpy()-prior[col].to_numpy()))))
                    for col in ('abstain', 'risk_rejected', 'width_rejected', 'hit', 'holiday'):
                        np.testing.assert_array_equal(new[col], prior[col])
                    for col in ('cal_start', 'cal_end'):
                        assert list(pd.to_datetime(prior[col], utc=True)) == list(new[col])
                    count += len(new)
        assert estimator_hash(model, q) == frozen
        assert sha(item['artifact']) == item['artifact_sha256']
        print(f"replay {item['month']}: PASS", flush=True)
    assert count == len(old) == 153600
    print(json.dumps(dict(status='PASS', replay_rows=count, max_numeric_csv_roundtrip_error=max_error,
                          deterministic_self_fits=5, source_artifacts_unchanged=11,
                          metadata_selection_verified=True, no_outputs_overwritten=True)), flush=True)


if __name__ == '__main__':
    main()
