"""Automatic dispatch sink: append-only local log, never a device connection."""
import json
from pathlib import Path

DATA_SOURCE = {
    'name': 'Building Data Genome 2 (BDG2)',
    'attribution': 'Miller, C., Kathirgamanathan, A., Picchetti, B. et al. (2020), Scientific Data 7, 368; buds-lab.',
    'url': 'https://github.com/buds-lab/building-data-genome-project-2',
    'license': 'CC BY-SA 4.0',
    'modifications': 'Selected hourly data; model forecasts; estimated floor allocation and synthetic PV/storage/grid fields.'
}


def score_confidence(risk_score):
    """Product score, not conformal coverage probability."""
    return round(max(0., min(1., 1.-float(risk_score))), 6)


def dispatch(record, path='logs/dispatch.jsonl'):
    target=Path(path);target.parent.mkdir(parents=True,exist_ok=True)
    entry={**record,'mode':'auto','transport':'log_only','device_connected':False}
    with target.open('a',encoding='utf-8') as stream:
        stream.write(json.dumps(entry,ensure_ascii=False,allow_nan=False)+'\n')
    return entry


def dispatch_to_bms(plan, building_id, path='logs/dispatch.jsonl'):
    """Validated accepted commands only; BA/EMS are log destinations, not devices."""
    import time
    from .tools import check_constraints
    start=time.perf_counter()
    if any(p.get('action')=='human_review' or p.get('abstain',False) for p in plan):
        raise ValueError('Refused hours must not be dispatched')
    # Full-horizon SOC is checked by run_agent; independently enforce hard command bounds before any log writes.
    import math
    for item in plan:
        temp=float(item['hvac_setpoint_c']);power=float(item['battery_kw'])
        if not math.isfinite(temp) or not math.isfinite(power) or not 24<=temp<=27 or abs(power)>500:
            raise ValueError('Invalid BA/EMS command')
    count=0
    for item in plan:
        for destination,command in [('BA',{'setpoint_c':item['hvac_setpoint_c']}),
                                    ('EMS',{'battery_kw':item['battery_kw']})]:
            dispatch({'building_id':building_id,'timestamp':item['timestamp'],
                      'destination':destination,'command':command,'status':'executed'},path)
            count+=1
    return {'count':count,'elapsed_ms':round((time.perf_counter()-start)*1000,3),
            'transport':'log_only','device_connected':False}
