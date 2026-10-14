"""Discrete hourly comfort-aware controls with cost and dual-peak guards."""
import copy
import math
import statistics
from .tools import tool_config, check_constraints
from .zone_comfort import enforce_plan, plan_safe, safe_setpoint, maximum_zone_temperature, occupied


def control_metrics(plan, predictions, hours, model=None):
    model = model or tool_config()['linear_model']
    cost = 0.; points = []; uppers = []
    for p, r, h in zip(plan, predictions, hours):
        if r['abstain']:
            continue
        factor = max(0., 1-model['load_fraction_per_degree']*(p['hvac_setpoint_c']-model['baseline_setpoint_c'])
                     + model['precool_extra_fraction']*(p['action']=='precool'))
        point = max(0., float(r['point'])*factor-float(h['pv_kw'])-p['battery_kw'])
        upper = max(0., float(r['upper'])*factor-float(h['pv_kw'])-p['battery_kw'])
        cost += point*float(h['price_per_kwh'])
        points.append(point); uppers.append(upper)
    return dict(energy_cost_cny=cost if points else None,
                point_grid_peak_kw=max(points) if points else None,
                upper_grid_peak_kw=max(uppers) if uppers else None)


def optimize_temperature(candidate, forecast, context, limits):
    """Optimize actual 0.1 C ticks, not display-only rounding.

    Comfort weight uses the window median load (not each hour's own load),
    so tariff and hourly load do not cancel out. Hot outdoor air increases the
    comfort weight and lowers the indoor comfort cap. Cooling is a policy
    budget, not a calibrated assertion of thermal storage savings.
    """
    unconstrained=copy.deepcopy(candidate['plan'])
    original=enforce_plan(copy.deepcopy(unconstrained),forecast['predictions'],context['hours'],limits)
    predictions=forecast['predictions'];hours=context['hours'];n=len(original)
    model=tool_config()['linear_model']
    low=math.ceil(limits['min_temp_c']*10-1e-9)/10
    high=math.floor(limits['max_temp_c']*10+1e-9)/10
    if low>high:raise ValueError('no 0.1 degree setpoint within bounds')
    hold=round(min(high,max(low,25.5)),1)
    median_load=statistics.median([max(1.,float(r['point'])) for r in predictions if not r['abstain']] or [1.])
    peak_load=statistics.median([max(1.,float(r['point'])) for r,h in zip(predictions,hours)
                                 if not r['abstain'] and h['tariff_period']=='peak'] or [median_load])
    def metrics(plan):return control_metrics(plan,predictions,hours,model)
    before=metrics(original)
    def comfort(j,temp):
        outdoor=hours[j].get('outdoor_temp_c')
        hot=max(0.,float(outdoor)-model['outdoor_reference_c']) if outdoor is not None else 0.
        indoor=temp+model['outdoor_gain']*hot
        excess=max(0.,indoor-limits['max_temp_c'])+max(0.,limits['min_temp_c']-indoor)
        weight=max(median_load,peak_load) if hours[j]['tariff_period']=='peak' else median_load
        return weight*(.015*(1+.07*hot)*(temp-hold)**2+.1*excess**2)
    def objective(plan):
        return (metrics(plan)['energy_cost_cny'] or 0.)+sum(comfort(j,p['hvac_setpoint_c'])
                    for j,p in enumerate(plan) if not predictions[j]['abstain'])
    def guarded(plan):
        m=metrics(plan)
        return plan_safe(plan,predictions,hours) and not check_constraints(plan,limits) and all(before[k] is None or m[k]<=before[k]+1e-7 for k in before)
    pairs=[];i=0
    while i<n:
        if not predictions[i]['abstain'] and hours[i]['tariff_period']=='peak':
            start=i
            while i<n and not predictions[i]['abstain'] and hours[i]['tariff_period']=='peak':i+=1
            pre=[]
            for j in range(start-1,max(-1,start-3),-1):
                if predictions[j]['abstain'] or hours[j]['tariff_period']=='peak':break
                pre.insert(0,j)
            if pre:pairs.append((pre,list(range(start,i))))
        else:i+=1
    def command(j,temp,precool=False):
        p=dict(original[j]);p['hvac_setpoint_c']=safe_setpoint(predictions[j],hours[j],round(temp,1),limits)
        p['action']='human_review' if predictions[j]['abstain'] else 'precool' if precool else 'dispatch' if p['battery_kw'] else 'hold'
        return p
    warm=copy.deepcopy(original)
    has_peak=any(h['tariff_period']=='peak' for h in hours)
    for j,(r,h) in enumerate(zip(predictions,hours)):
        if r['abstain']:continue
        period=h['tariff_period']
        if period=='flat' and not has_peak:continue
        outdoor=h.get('outdoor_temp_c')
        hot=max(0.,float(outdoor)-model['outdoor_reference_c']) if outdoor is not None else 0.
        cap=min(safe_setpoint(r,h,high,limits),math.floor((limits['max_temp_c']-model['outdoor_gain']*hot)*10+1e-9)/10)
        lower=max(low,26. if period=='peak' else hold)
        upper=min(cap,high if period=='peak' else 26.)
        choices=[safe_setpoint(r,h,hold,limits)]+[tick/10 for tick in range(math.ceil(lower*10),math.floor(upper*10)+1)]
        best=warm[j];best_value=float('inf')
        for temp in choices:
            trial=command(j,temp)
            single=control_metrics([trial],[r],[h],model)
            value=(single['energy_cost_cny'] or 0.)+comfort(j,temp)
            if value<best_value:best=trial;best_value=value
        warm[j]=best
    proposals=[]
    # Try 1-2 hours of 24.5..25.0 cooling. Keep per-hour peak temperatures,
    # rather than forcing a single warming temperature across a whole block.
    cooling=copy.deepcopy(warm);found=False
    for pre,block in pairs:
        best=None;best_value=float('inf')
        for count in (1,2):
            selected=pre[-count:]
            for tick in range(245,251):
                temp=tick/10
                if not low<=temp<=high:continue
                trial=copy.deepcopy(cooling)
                for j in selected:trial[j]=command(j,temp,True)
                if sum(trial[j]['hvac_setpoint_c']-hold for j in block)/len(block)>4*sum(hold-trial[j]['hvac_setpoint_c'] for j in selected)+1e-7:continue
                if not guarded(trial):continue
                value=objective(trial)
                if value<best_value:best=trial;best_value=value
        if best is not None:cooling=best;found=True
    if found:proposals.append(cooling)
    proposals.append(warm)
    proposed=original;old_value=objective(original)
    for plan in proposals:
        if guarded(plan) and objective(plan)<old_value-1e-6:
            proposed=plan;break
    enforce_plan(proposed,predictions,hours,limits)
    assert plan_safe(proposed,predictions,hours)
    after=metrics(proposed);applied=proposed!=unconstrained
    for p in proposed:
        p['reason']=(f"按负荷区间上界 {p['prepared_upper_kw']:.1f} kW准备，"
                     f"设定温度 {p['hvac_setpoint_c']:.1f} °C，储能功率 {p['battery_kw']:.1f} kW。")
    candidate['plan']=proposed
    candidate['temperature_optimization']=dict(before=before,after=after,applied=applied,
        comfort_penalty='quadratic_deviation_from_25.5',comfort_penalty_cny_per_kw_degree2=.015,
        comfort_excess_penalty_cny_per_kw_degree2=.1,precool_warming_budget_ratio=4.,
        precool_budget_basis='mean_peak_warming_over_two_prepeak_hours',setpoint_step_c=.1,
        scope='accepted_hours',zone_comfort_source='src.ops.metrics.floor_rows',occupied_hours='07-20 inclusive',
        occupied_zone_limit_c=27.,comfort_corrections=sum(a['hvac_setpoint_c']!=b['hvac_setpoint_c'] for a,b in zip(unconstrained,original)),
        max_zone_temperature_c=max(maximum_zone_temperature(r,h,p['hvac_setpoint_c']) for p,r,h in zip(proposed,predictions,hours) if occupied(r)) if any(occupied(r) for r in predictions) else None)
    return candidate
