import copy
import numpy as np
import pandas as pd
import pytest
from src.conformal.daily_local import fit_local, fit_reference, issue, daily, metrics

CFG={'risk_weights':[.7,.15,.1,.05],'rejection_fraction':.15,'alpha':.095,'max_relative_width':1.0}


def sample(days=13):
    rng=np.random.default_rng(42);n=days*24
    t=pd.date_range('2017-01-01',periods=n,freq='h',tz='UTC')
    f=pd.DataFrame({'timestamp':t,'building_id':'b','y':100+rng.normal(0,8,n),'point':100.,'scale':8.,
        'raw_low':94.,'raw_high':106.})
    for i in range(4):f[f'risk_{i}']=rng.uniform(0,1,n) if i<2 else .1
    return f


def test_issue_ignores_unseen_outcomes_and_preserves_point():
    f=sample();cal=f.iloc[:240];ev=f.iloc[240:];state=fit_local(cal,CFG)
    p=issue(ev,state,CFG);other=ev.copy();other['y']=1e9
    pd.testing.assert_frame_equal(p,issue(other,state,CFG))
    np.testing.assert_array_equal(p.point,ev.point)
    assert (p.cal_end < p.timestamp).all()


def test_daily_cannot_use_today_or_future_outcomes():
    f=sample();start=f.timestamp.iloc[240];p=daily(f,start,CFG)
    other=f.copy();other.loc[other.timestamp>=start,'y']=1e6
    q=daily(other,start,CFG)
    first=p.timestamp.dt.floor('D').eq(start)
    for col in ['point','lower','upper','threshold','q','abstain']:
        np.testing.assert_array_equal(p.loc[first,col],q.loc[first,col])
    assert (p.cal_end < p.timestamp.dt.floor('D')).all()
    assert (p.cal_n==240).all()
    assert p.q.iloc[-1]!=q.q.iloc[-1]  # yesterday feedback may affect later days


def test_buildings_are_calibrated_separately():
    a=sample();b=a.copy();b['building_id']='other';b['y']=b.y+35
    f=pd.concat([a,b]);start=a.timestamp.iloc[240]
    p=daily(f,start,CFG);expected=daily(a,start,CFG)
    pd.testing.assert_frame_equal(p[p.building_id.eq('b')].reset_index(drop=True),expected)
    assert p[p.building_id.eq('other')].q.iloc[0] > expected.q.iloc[0]
    with pytest.raises(ValueError):fit_local(f,CFG)


def test_empty_or_short_calibration_fails_closed():
    f=sample();start=f.timestamp.iloc[24]
    with pytest.raises(ValueError):daily(f,start,CFG,min_rows=120)
    with pytest.raises(ValueError):fit_local(f.iloc[:0],CFG)


def test_normalized_interval_and_metrics_denominators():
    f=sample();state=fit_reference(f.iloc[:240],CFG,'normalized');p=issue(f.iloc[240:],state,CFG)
    p['y']=f.y.iloc[240:].to_numpy();p['hit']=(p.y>=p.lower)&(p.y<=p.upper)
    m=metrics(p)
    assert m['n']==72 and m['retained_n']==int((~p.abstain).sum())
    assert m['all_coverage']==float(p.hit.mean())
    assert m['retained_coverage']==float(p.loc[~p.abstain,'hit'].mean())


def test_uploaded_daily_aggregates_match_metrics():
    import json
    from pathlib import Path
    root=Path('experiments/calibration_v1')
    for stage in ['byron','six']:
        result=json.loads((root/(stage+'_results.json')).read_text(encoding='utf-8'))
        counts=pd.read_csv(root/(stage+'_daily_counts.csv'))
        for name,g in counts.groupby('method'):
            m=result['pooled'][name]
            assert int(g.n.sum())==m['n']
            assert int(g.retained_n.sum())==m['retained_n']
            assert np.isclose(g.covered_n.sum()/g.n.sum(),m['all_coverage'])
            assert np.isclose(g.covered_retained_n.sum()/g.retained_n.sum(),m['retained_coverage'])
            assert np.isclose(g.rejected_n.sum()/g.n.sum(),m['rejection_rate'])


def test_uploaded_cold_selection_and_error_metrics():
    import json
    from pathlib import Path
    root=Path('experiments/calibration_v1')
    result=json.loads((root/'cold_results.json').read_text(encoding='utf-8'))
    decisions=json.loads((root/'cold_weekly_decisions.json').read_text(encoding='utf-8'))
    weeks=pd.read_csv(root/'cold_weekly_metrics.csv')
    assert len(decisions)==312
    assert sum(w['enabled'] for w in decisions)==286
    assert int((weeks.enabled & (weeks.mae_gain<0)).sum())==14
    for w in decisions:
        if w['validation']:
            assert w['enabled']==(w['validation']['candidate_mae']<w['validation']['base_mae'])
            assert pd.Timestamp(w['fit_end'])<pd.Timestamp(w['cal_end'])<pd.Timestamp(w['start'])
        else:assert not w['enabled']
    for row in result['by_building']:
        g=weeks[weeks.building_id.eq(row['building'])]
        assert np.isclose(g.base_abs_error_sum.sum()/g.n.sum(),row['base_mae'])
        assert np.isclose(g.candidate_abs_error_sum.sum()/g.n.sum(),row['candidate_mae'])
    assert result['buildings_improved']==12
    assert np.isclose(np.mean([r['mae_gain'] for r in result['by_building']]),result['macro_mae_gain'])
