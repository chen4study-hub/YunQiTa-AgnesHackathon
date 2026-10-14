"""24 hourly steps: peak-first LP, then tariff cost; valley charge/peak discharge, optional manual pre-peak flat charge."""
from datetime import datetime
import numpy as np
from scipy.optimize import linprog


def chinese_hour(timestamp,origin):
    from .display_text import relative_time
    return relative_time(timestamp,origin)


def reserve_summary(plan):
    future=[p for p in plan[1:] if p['battery_kw']>1e-6]
    if future:
        return '储能按完整窗口统筹，为'+ '、'.join(chinese_hour(p['timestamp'],plan[0]['timestamp']) for p in future)+'峰段留电；窗口末电量不低于起点，每小时只执行首步后重规划。'
    return '本窗口没有可安全获益的后续放电时段，保持或恢复电量；每小时只执行首步后重规划。'


def optimize_power(predictions,hours,limits,scale,allow_prepeak_charge=False):
    """Unit efficiency, terminal >= initial. Refused steps fixed zero; no future weather."""
    from .tools import tool_config
    n=len(predictions);capacity=limits['battery_capacity_kwh'];soc=limits['initial_soc']
    model=tool_config()['linear_model'];factor=1-model['load_fraction_per_degree']*1.5
    point=np.array([max(0.,r['point']*factor-h['pv_kw']) for r,h in zip(predictions,hours)])
    upper=np.array([max(0.,r['upper']*factor-h['pv_kw']) for r,h in zip(predictions,hours)])
    accepted=[i for i,r in enumerate(predictions) if not r['abstain']]
    max_power=min(500.,limits['battery_max_kw'])*scale
    prepeak={i for i,h in enumerate(hours) if h['tariff_period']=='flat' and
             any(x['tariff_period']=='peak' for x in hours[i+1:i+3])} if allow_prepeak_charge else set()
    bounds=[]
    for i,(r,h) in enumerate(zip(predictions,hours)):
        if r['abstain']:bounds.append((0.,0.))
        elif h['tariff_period']=='valley' or i in prepeak:bounds.append((-max_power,0.))
        elif h['tariff_period']=='peak':bounds.append((0.,min(max_power,point[i])))
        else:bounds.append((0.,0.))
    # variables hourly positive-discharge power + accepted-hour upper peak.
    A=[];b=[]
    for i in range(n):
        prefix=np.zeros(n+1);prefix[:i+1]=1.
        A.extend([prefix,-prefix]);b.extend([(soc-limits['min_soc'])*capacity,(limits['max_soc']-soc)*capacity])
    terminal=np.zeros(n+1);terminal[:n]=1.;A.append(terminal);b.append(0.)
    for i in accepted:
        peak=np.zeros(n+1);peak[i]=-1.;peak[-1]=-1.;A.append(peak);b.append(-upper[i])
    bounds.append((0.,None))
    first=np.zeros(n+1);first[-1]=1.
    result=linprog(first,A_ub=A,b_ub=b,bounds=bounds,method='highs')
    if not result.success:raise ValueError('storage peak optimization infeasible')
    peak_row=np.zeros(n+1);peak_row[-1]=1.;A.append(peak_row);b.append(result.x[-1]+1e-7)
    cost=np.array([-h['price_per_kwh'] if i in accepted else 0. for i,h in enumerate(hours)]+[0.])
    result=linprog(cost,A_ub=A,b_ub=b,bounds=bounds,method='highs')
    if not result.success:raise ValueError('storage cost optimization infeasible')
    cost_row=cost.copy();A.append(cost_row);b.append(result.fun+1e-7)
    # Resolve ties by minimal throughput (no pointless cycling / flat terminal surplus).
    throughput=np.array([-1. if h['tariff_period']=='valley' or i in prepeak else 1. for i,h in enumerate(hours)]+[0.])
    result=linprog(throughput,A_ub=A,b_ub=b,bounds=bounds,method='highs')
    if not result.success:raise ValueError('storage tie optimization infeasible')
    # Numerical safety margin without modifying SOC gate or forecast values.
    power=[0. if abs(p)<1e-6 else float(p)*(1-1e-9) for p in result.x[:n]]
    # Solver tolerances must not leak into strict SOC validation near a boundary.
    prefix=0.; safe_scale=1.
    for p in power:
        prefix+=p
        if prefix>0:
            safe_scale=min(safe_scale, max(0.,(soc-limits['min_soc'])*capacity/prefix))
        elif prefix<0:
            safe_scale=min(safe_scale, max(0.,(limits['max_soc']-soc)*capacity/(-prefix)))
    if any(power):
        # Also leave round-off room when prefix sums and sequential SOC differ.
        power=[p*safe_scale*(1-1e-6) for p in power]
    # Validate with the same sequential arithmetic as the command checker.
    running_soc=soc
    for i,p in enumerate(power):
        if p>0:
            p=min(p,max(0.,(running_soc-limits['min_soc']-1e-12)*capacity))
        elif p<0:
            p=max(p,-max(0.,(limits['max_soc']-running_soc-1e-12)*capacity))
        power[i]=p;running_soc-=p/capacity
    # Clipping a charge by round-off must not create terminal energy consumption.
    surplus=sum(power)
    if surplus>0:
        for i in reversed(range(n)):
            if power[i]>0:
                reduction=min(power[i],surplus)
                power[i]-=reduction;surplus-=reduction
                if surplus<=0:break
    # Terminal balancing can slightly increase later SOC; recheck charge bounds.
    running_soc=soc
    for i,p in enumerate(power):
        if p<0:
            p=max(p,-max(0.,(limits['max_soc']-running_soc-1e-12)*capacity))
        power[i]=p;running_soc-=p/capacity
    return power


def rolling_candidate(forecast,context,limits,candidate_id,scale,allow_prepeak_charge=False):
    predictions=forecast['predictions'];hours=context['hours']
    if len(predictions)!=len(hours):raise ValueError('Context/forecast horizon mismatch')
    if any(datetime.fromisoformat(r['timestamp'])!=datetime.fromisoformat(h['timestamp']) for r,h in zip(predictions,hours)):
        raise ValueError('Context timestamp mismatch')
    powers=optimize_power(predictions,hours,limits,scale,allow_prepeak_charge) if scale else [0.]*len(hours)
    plan=[]
    for r,p in zip(predictions,powers):
        action='human_review' if r['abstain'] else 'dispatch' if p else 'hold'
        plan.append(dict(timestamp=r['timestamp'],hvac_setpoint_c=25.5,battery_kw=p,action=action,
            source='rule',prepared_upper_kw=float(r['upper']),
            reason=f"按负荷区间上界 {r['upper']:.1f} kW准备，储能功率 {p:.1f} kW；低置信时段不充放电。"))
    return dict(candidate_id=candidate_id,plan=plan)


def unique_candidates(candidates):
    # Prefer explicit hold name when zero-power controls are identical.
    seen=set();out=[]
    for c in sorted(candidates,key=lambda c:c['candidate_id']!='rule_hold'):
        key=tuple((p['timestamp'],round(p['battery_kw'],6),p['hvac_setpoint_c'],p['action']) for p in c['plan'])
        if key not in seen:seen.add(key);out.append(c)
    return sorted(out,key=lambda c:['rule_full','rule_conservative','rule_hold'].index(c['candidate_id']))
