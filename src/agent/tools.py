"""Deterministic tools; returned forecast is the only source of forecast numbers."""
from typing import Callable, Protocol
import math
import json
from pathlib import Path
from datetime import datetime


class Provider(Protocol):
    def propose(self, forecast: dict, constraints: dict) -> dict: ...


def get_forecast(fetch: Callable, building_id: str, start, end):
    """Fetch each hour of an end-exclusive range; preserves model refusal and confidence."""
    from datetime import timedelta
    start=datetime.fromisoformat(start.replace('Z','+00:00')) if isinstance(start,str) else start
    end=datetime.fromisoformat(end.replace('Z','+00:00')) if isinstance(end,str) else end
    if start.tzinfo is None or end.tzinfo is None or end<=start or (end-start).total_seconds()%3600:
        raise ValueError('timezone-aware whole-hour range required')
    rows=[];versions=[];target=start
    while target<end:
        result=fetch(building_id,target,target+timedelta(hours=1))
        rows.extend(result['predictions']);versions.append(result['model_version']);target+=timedelta(hours=1)
    return dict(building_id=building_id,model_version=versions[0] if len(set(versions))==1 else 'monthly_mixed',predictions=rows)


def check_constraints(plan, constraints=None):
    defaults=tool_config()['equipment']
    constraints={**defaults, **(constraints or {})}
    constraints['min_temp_c']=max(24.,constraints['min_temp_c'])
    constraints['max_temp_c']=min(27.,constraints['max_temp_c'])
    constraints['battery_max_kw']=min(500.,constraints['battery_max_kw'])
    constraints['min_soc']=max(.1,constraints['min_soc'])
    constraints['max_soc']=min(.95,constraints['max_soc'])
    failures = []
    if not all(math.isfinite(float(constraints[k])) for k in defaults) or constraints['battery_capacity_kwh']<=0:
        return ['invalid_constraints']
    if constraints['min_temp_c']>constraints['max_temp_c'] or constraints['battery_max_kw']<0:
        return ['invalid_constraints']
    if not constraints['min_soc']<=constraints['initial_soc']<=constraints['max_soc']:
        failures.append('battery_soc')
    soc = constraints['initial_soc']
    for entry in plan:
        try:
            t = float(entry['hvac_setpoint_c'])
            kw = float(entry['battery_kw'])
            if not math.isfinite(t) or not math.isfinite(kw):
                failures.append('nonfinite_control')
                continue
            if entry.get('action', 'hold') not in ('hold', 'human_review', 'dispatch', 'precool'):
                failures.append('invalid_action')
            if entry.get('action') == 'human_review' and kw != 0:
                failures.append('handoff_power')
            if not constraints['min_temp_c'] <= t <= constraints['max_temp_c']:
                failures.append('comfort_temperature')
            if abs(kw) > constraints['battery_max_kw']:
                failures.append('battery_power')
        except (ValueError, KeyError, TypeError):
            failures.append('invalid_plan_entry')
            continue
        # One-hour step, positive discharge; configured unit efficiency linear approximation.
        soc -= kw / constraints['battery_capacity_kwh']
        if not constraints['min_soc'] <= soc <= constraints['max_soc']:
            failures.append('battery_soc')
    return sorted(set(failures))


def simulate_schedule(plan, forecast, constraints=None, context=None, precool_hours=()):
    constraints=constraints or {}
    if context is not None:
        return simulate_linear(plan,forecast,context,constraints,precool_hours)
    if any(p['abstain'] for p in forecast['predictions']):
        return {'estimated_cost': None, 'estimated_savings': None,
                'reason': 'abstaining forecasts cannot establish cost estimates'}
    if 'context' not in constraints:
        return {'estimated_cost': None, 'estimated_savings': None,
                'reason': 'hourly tariff/PV/context required for linear simulation'}
    return simulate_linear(plan, forecast, constraints['context'], constraints)


def tool_config():
    return json.loads((Path(__file__).resolve().parents[2]/'configs/agent_tools.json').read_text(encoding='utf-8'))


def replay_soc(row):
    """Canonical current exported snapshot, NOT previous-hour SOC or a new simulation."""
    soc=row['storage']['soc']
    if isinstance(soc,bool) or not isinstance(soc,(int,float)) or not math.isfinite(soc) or not 0<=soc<=1:
        raise ValueError('invalid replay SOC snapshot')
    return float(soc)


def get_context(building_id, start, end, replay=None):
    """Explicit replay context source; no invented weather/SOC/PV for unsupported dates."""
    def parse(t):return datetime.fromisoformat(t.replace('Z','+00:00')) if isinstance(t,str) else t
    start,end=parse(start),parse(end)
    if start.tzinfo is None or end.tzinfo is None or end<=start:raise ValueError('invalid context range')
    config=tool_config();tariff=config['tariff']
    sources=[replay] if replay is not None else [json.loads(p.read_text(encoding='utf-8'))
        for p in (Path(__file__).resolve().parents[2]/'exports/replay').glob('*.json') if p.stem in ('normal','peak','abstain')]
    selected={}
    for data in sources:
        if data['meta']['building_id']!=building_id:continue
        for row in data['hours']:
            timestamp=parse(row['t']);hour=timestamp.hour
            period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
            if start<=timestamp<end:
                from src.data.replay_payload import ensure_hour
                row=ensure_hour(data,row)
                selected[row['t']]=dict(timestamp=row['t'],outdoor_temp_c=row['outdoor_temp_c'],
                    tariff_period=period,price_per_kwh=tariff[period],currency=tariff['currency'],
                    storage_soc=replay_soc(row),pv_kw=row['pv']['power_kw'],
                    storage_soc_source='replay.storage.soc',
                    storage_soc_basis='current exported snapshot; derived from exported executed commands',
                    source='historical replay; synthetic storage/PV; configured tariff')
    expected=(end-start).total_seconds()/3600
    if expected!=int(expected) or len(selected)!=expected:raise ValueError('complete hourly context unavailable')
    return dict(building_id=building_id,hours=sorted(selected.values(),key=lambda r:parse(r['timestamp'])),tariff_source=tariff['source'])


def simulate_linear(plan, forecast, context, constraints=None, precool_hours=()):
    """One-hour linear scenario estimate; no validated physical/control-savings claim."""
    limits={**tool_config()['equipment'],**(constraints or {})}
    failures=check_constraints(plan,limits)
    if failures:raise ValueError('invalid schedule: '+','.join(failures))
    predictions=forecast['predictions']
    if any(r['abstain'] for r in predictions):
        return dict(estimated_cost=None,estimated_savings=None,reason='abstaining forecasts require human review')
    contexts={datetime.fromisoformat(h['timestamp'].replace('Z','+00:00')):h for h in context['hours']}
    if len(plan)!=len(predictions) or len(contexts)!=len(plan):raise ValueError('hourly alignment required')
    model=tool_config()['linear_model'];soc=limits['initial_soc'];rows=[]
    for command,prediction in zip(plan,predictions):
        if command['timestamp']!=prediction['timestamp']:raise ValueError('timestamp mismatch')
        key=datetime.fromisoformat(command['timestamp'].replace('Z','+00:00'));h=contexts[key]
        base=float(prediction['point']);temp=float(command['hvac_setpoint_c']);power=float(command['battery_kw'])
        precool=command['timestamp'] in precool_hours or command.get('action')=='precool'
        factor=max(0.,1-model['load_fraction_per_degree']*(temp-model['baseline_setpoint_c'])+model['precool_extra_fraction']*precool)
        load=base*factor;pv=float(h['pv_kw']);price=float(h['price_per_kwh'])
        grid=max(0.,load-pv-power);baseline=max(0.,base-pv)
        outdoor=h['outdoor_temp_c']
        if outdoor is None:raise ValueError('outdoor temperature unavailable for comfort estimate')
        from .zone_comfort import maximum_zone_temperature, occupied
        indoor=maximum_zone_temperature(prediction,h,temp)
        # What-if comparison reports comfort excess; it does not authorize dispatch.
        # Automatic commands and manual recommendations are hard-checked by planner.
        if not all(math.isfinite(v) for v in (base,pv,price,grid,indoor)) or min(base,pv,price)<0:
            raise ValueError('invalid scenario input')
        soc-=power/limits['battery_capacity_kwh']
        rows.append(dict(timestamp=command['timestamp'],load_kw=load,grid_kw=grid,load_kwh=load,grid_kwh=grid,cost=grid*price,
            baseline_cost=baseline*price,soc=soc,estimated_indoor_temp_c=indoor,
            comfort_degree_hours=max(0.,limits['min_temp_c']-indoor)+max(0.,indoor-limits['max_temp_c'])))
    cost=sum(r['cost'] for r in rows);baseline_cost=sum(r['baseline_cost'] for r in rows)
    return dict(estimated_energy_kwh=sum(r['grid_kwh'] for r in rows),estimated_cost=cost,
        estimated_savings=baseline_cost-cost,estimated_peak_kw=max(r['grid_kwh'] for r in rows),
        comfort_degree_hours=sum(r['comfort_degree_hours'] for r in rows),hours=rows,
        model='configured unvalidated linear scenario; unit battery efficiency; no calibrated counterfactual savings')


def explain_uncertainty(forecast):
    explanations=[]
    for row in forecast['predictions']:
        if not row['abstain']:continue
        evidence={k:row[k] for k in ('confidence','lower','upper','risk_score','risk_threshold','abstain_reason') if k in row}
        if 'lower' in row and 'upper' in row:evidence['interval_width']=row['upper']-row['lower']
        reasons=[]
        if 'risk_score' in row and 'risk_threshold' in row and row['risk_score']>row['risk_threshold']:
            reasons.append('risk_score_above_threshold')
        if row.get('abstain_reason')=='interval_too_wide':reasons.append('interval_width_guard')
        if not reasons:reasons.append('model_reported_abstention; specific trigger not available in supplied data')
        explanations.append(dict(timestamp=row['timestamp'],reasons=reasons,evidence=evidence,action='human_review'))
    return explanations
