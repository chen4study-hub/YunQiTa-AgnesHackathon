"""Read-only Ops zone-temperature authority; no Ops files or calendar writes."""
from datetime import datetime
from functools import lru_cache
import math
from src.ops.metrics import floor_rows
from scripts.replay_floor_allocation import floors, USES

OCCUPIED_START=7
OCCUPIED_END=20  # inclusive: the 20:00 operating hour is also protected
ZONE_MAX_C=27.


def source_for(prediction,hour):
    t=datetime.fromisoformat(prediction['timestamp'].replace('Z','+00:00'))
    point=round(float(prediction['point']),1)
    weights=hour.get('floors_kw') or floors(point,t.hour,t.date().isoformat())
    uses=hour.get('floor_uses') or USES
    if len(weights)!=len(uses):raise ValueError('zone floor/usage mismatch')
    return t,dict(floors_kw=weights,actual_kw=float(hour.get('actual_kw',point)),
                  outdoor_temp_c=hour.get('outdoor_temp_c')) ,uses


@lru_cache(maxsize=16384)
def _max(day,hour,outdoor,weights,uses,setpoint):
    source=dict(floors_kw=list(weights),actual_kw=sum(weights),outdoor_temp_c=outdoor,
                agent={'hvac_setpoint_c':setpoint})
    rows,_,_=floor_rows(day,hour,source,list(uses))
    return max(z['temp_c'] for f in rows for z in f['zones'])


def maximum_zone_temperature(prediction,hour,setpoint):
    t,source,uses=source_for(prediction,hour)
    return _max(t.date().isoformat(),t.hour,source['outdoor_temp_c'],tuple(source['floors_kw']),tuple(uses),float(setpoint))


def occupied(prediction):
    h=datetime.fromisoformat(prediction['timestamp'].replace('Z','+00:00')).hour
    return OCCUPIED_START<=h<=OCCUPIED_END


def safe_setpoint(prediction,hour,setpoint,limits):
    temp=math.floor(float(setpoint)*10+1e-8)/10
    if occupied(prediction):
        while temp>=limits['min_temp_c']-1e-8 and maximum_zone_temperature(prediction,hour,temp)>ZONE_MAX_C:
            temp=round(temp-.1,1)
        if temp<limits['min_temp_c']-1e-8:
            raise ValueError('no setpoint satisfies occupied zone comfort; manual intervention required')
    return round(temp,1)


def enforce_plan(plan,predictions,hours,limits):
    if not len(plan)==len(predictions)==len(hours):raise ValueError('comfort window mismatch')
    for p,r,h in zip(plan,predictions,hours):
        p['hvac_setpoint_c']=safe_setpoint(r,h,p['hvac_setpoint_c'],limits)
    return plan


def plan_safe(plan,predictions,hours):
    return all(not occupied(r) or maximum_zone_temperature(r,h,p['hvac_setpoint_c'])<=ZONE_MAX_C
               for p,r,h in zip(plan,predictions,hours))
