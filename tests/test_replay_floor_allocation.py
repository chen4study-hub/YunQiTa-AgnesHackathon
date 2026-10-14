"""Prepared floor allocator only; existing exports/contracts are intentionally unchanged."""
import math
import numpy as np
import pytest
from scripts.replay_floor_allocation import floors,floor_weights,USES,DENSITIES


def test_fixed_density_and_floor_use_roles():
    assert len(USES)==40 and len(DENSITIES)==40
    assert min(DENSITIES)>=.75 and max(DENSITIES)<=1.25
    assert np.array_equal(DENSITIES,np.random.default_rng(42).uniform(.75,1.25,40))
    assert USES[0]=='lobby' and USES[1]==USES[38]=='equipment'
    assert USES[13]==USES[26]=='garden'


def test_hourly_jitter_is_small_deterministic_and_date_specific():
    for day in ['2017-07-03','2017-07-04','2017-10-23']:
        for hour in range(24):
            noisy=floor_weights(hour,day);base=floor_weights(hour,day,jitter=False)
            assert np.all(np.abs(noisy/base-1)<=.04+1e-12)
            assert np.array_equal(noisy,floor_weights(hour,day))
    assert not np.array_equal(floor_weights(10,'2017-07-03'),floor_weights(10,'2017-07-04'))
    assert not np.array_equal(floor_weights(10,'2017-07-03'),floor_weights(11,'2017-07-03'))


def test_floor_totals_preserved_and_nonuniform_at_all_hours():
    for total in [0.,1.1,333.3,1000.,1299.8,2488.]:
        for hour in range(24):
            values=floors(total,hour,'2017-07-04')
            assert len(values)==40 and min(values)>=0
            assert sum(round(v*10) for v in values)==round(total*10)
            assert math.isclose(sum(values),total,abs_tol=1e-8)
            if total>0:assert len(set(values))>1
    assert floors(0.,10)==[0.]*40
    for invalid in [float('nan'),float('inf'),-1.,1.234]:
        with pytest.raises(ValueError):floors(invalid,10)


def test_office_night_mean_and_share_lower_than_day_and_late_tenants():
    office=[i for i,u in enumerate(USES) if u=='office']
    infrastructure=[i for i,u in enumerate(USES) if u in ('equipment','lobby')]
    for day in ['2017-07-03','2017-07-04','2017-10-23']:
        night=[np.array(floors(1000.,h,day)) for h in (0,1,2,3,4,5,22,23)]
        daytime=[np.array(floors(1000.,h,day)) for h in range(10,18)]
        # Same total is redistributed proportionally; night is not concentrated
        # on plant floors. Actual building total, not these shares, sets scale.
        assert abs(np.mean([v[office].mean() for v in night])-np.mean([v[office].mean() for v in daytime]))<1.
        assert all(v[infrastructure].sum()<v[office].sum() for v in night)
    for floor in [8,19,31]:
        # Density cancels; these tenants are present later, absent during normal8h arrival.
        assert floor_weights(20,jitter=False)[floor-1]/DENSITIES[floor-1]==pytest.approx(1.)
        assert floor_weights(8,jitter=False)[floor-1]/DENSITIES[floor-1]==pytest.approx(.685)
    assert floor_weights(12,jitter=False)[13]>floor_weights(0,jitter=False)[13]
    assert floor_weights(0,jitter=False)[0]!=floor_weights(12,jitter=False)[0]


def test_every_hour_floor_max_at_most_two_point_five_office_median():
    office=[i for i,u in enumerate(USES) if u=='office']
    for date in ['2017-07-04','2017-07-20','2017-10-23','2026-10-12']:
        for hour in range(24):
            for total in [100.,800.,1500.,10000.]:
                v=np.array(floors(total,hour,date));median=np.median(v[office])
                assert v.max()/median<=2.5
                assert max(v[1],v[38])/median<2.05
                assert v[0]>median and v[0]/median<1.5
                assert round(v.sum(),1)==total
