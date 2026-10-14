"""Synthetic deterministic floor allocation, not measured submeter data."""
import hashlib
import math
import numpy as np

SEED=42
USES=['equipment' if i in (2,39) else 'garden' if i in (14,27) else 'lobby' if i==1 else 'office' for i in range(1,41)]
DENSITIES=np.random.default_rng(SEED).uniform(.75,1.25,40)
LATE_FLOORS={8,19,31}


def floor_weights(hour,date='2017-01-01',jitter=True):
    # Shared plant/storage/building services are spread proportionally, not
    # concentrated on equipment floors. Tenant schedule is a modest increment.
    office=[]
    for index,use in enumerate(USES):
        if use!='office':continue
        start,end=(10,21) if index+1 in LATE_FLOORS else (8,18)
        curve=1.0 if start<=hour<end else .30 if hour in (start-1,end) else .10
        office.append(DENSITIES[index]*(.65+.35*curve))
    median=float(np.median(office));weights=[]
    for index,use in enumerate(USES):
        floor=index+1
        if use=='office':
            start,end=(10,21) if floor in LATE_FLOORS else (8,18)
            curve=1.0 if start<=hour<end else .30 if hour in (start-1,end) else .10
            weight=DENSITIES[index]*(.65+.35*curve)
        elif use=='equipment':weight=1.8*median
        elif use=='lobby':weight=1.35*median
        else:weight=(.70+.15*max(0.,math.sin(math.pi*(hour-6)/14)))*median
        if jitter:
            digest=hashlib.sha256(f'{SEED}:{date}:{hour}:{floor}'.encode()).digest()
            weight*=1.+.04*(2*int.from_bytes(digest[:8],'big')/(2**64-1)-1)
        weights.append(weight)
    return np.array(weights)


def floors(point,hour,date='2017-01-01'):
    if not math.isfinite(point) or point<0:raise ValueError('Floor total must be finite and nonnegative')
    units=round(point*10)
    if not math.isclose(units/10,point,abs_tol=1e-8):raise ValueError('Floor total must have one-decimal export precision')
    weights=floor_weights(hour,date);weighted=weights/weights.sum()*units
    base=np.floor(weighted).astype(int)
    for i in np.argsort(-(weighted-base),kind='stable')[:units-int(base.sum())]:base[i]+=1
    assert int(base.sum())==units
    return (base/10).tolist()
