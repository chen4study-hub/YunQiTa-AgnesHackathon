import pandas as pd
from scripts.monthly_backtest import split_month


def test_monthly_fit_and_calibration_strictly_precede_evaluation():
    frame=pd.DataFrame({'timestamp':pd.date_range('2016-01-20','2017-12-31 23:00',freq='h',tz='UTC')})
    for month in range(1,13):
        start=pd.Timestamp(year=2017,month=month,day=1,tz='UTC')
        train,cal,evaluation=split_month(frame,start)
        assert train.timestamp.max()<cal.timestamp.min()
        assert cal.timestamp.max()<start==evaluation.timestamp.min()
        assert len(cal)==28*24
        assert (evaluation.timestamp.dt.month==month).all()


def test_completed_monthly_receipt_has_causal_splits():
    import json
    from pathlib import Path
    d=json.loads(Path('experiments/monthly_backtest_results.json').read_text(encoding='utf-8'))
    assert d['completed']==30 and d['skipped']==6
    for row in d['rows']:
        if row['status']=='completed':
            assert pd.Timestamp(row['train_end'])<pd.Timestamp(row['calibration_start'])
            assert pd.Timestamp(row['calibration_end'])<pd.Timestamp(row['evaluation_start'])
    assert d['hyperparameters_retuned'] is False and d['replay_updated'] is False
