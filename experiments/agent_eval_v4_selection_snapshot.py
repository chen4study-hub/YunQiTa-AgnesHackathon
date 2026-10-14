"""Explicit auditable peak-first objective; never delegate optimization policy to LLM."""
import math

POLICY={'id':'upper_grid_peak_tolerance_then_cost_v2',
    'priority':['min_cost_within_peak_tolerance_band','min_upper_grid_peak_kw','candidate_id'],
    'peak_tolerance_absolute_kw':1.,'peak_tolerance_relative':.001,
    'peak_tolerance_anchor':'global minimum candidate upper peak; inclusive band',
    'peak_penalty_cny_per_kw':None,'billing_claim':False,
    'scope':'constraint-valid accepted hours only; rejected hours excluded; no calibrated counterfactual savings',
    'note':'fixed tolerance band, energy cost first within band; no invented demand charge'}


def policy_order(candidates):
    peaks=[c['objective_metrics']['upper_grid_peak_kw'] for c in candidates if c['objective_metrics']['upper_grid_peak_kw'] is not None]
    minimum=min(peaks) if peaks else None
    tolerance=max(POLICY['peak_tolerance_absolute_kw'],POLICY['peak_tolerance_relative']*minimum) if minimum is not None else None
    def rank(c):
        m=c['objective_metrics'];peak=m['upper_grid_peak_kw'];cost=m['energy_cost_cny']
        inside=minimum is None or (peak is not None and peak<=minimum+tolerance)
        return (not inside,cost if cost is not None else math.inf,peak if peak is not None else math.inf,c['candidate_id'])
    return sorted(candidates,key=rank),minimum,tolerance


def misleading_tradeoff(text,selection):
    import re
    from .display_text import ungroup_text
    text=ungroup_text(text)
    gain=selection.get('upper_peak_reduction_vs_cheapest_kw')
    delta=selection.get('additional_cost_cny')
    # Reject marginal peak-buying claims where the host chose tolerance/cost instead.
    zero=bool(re.search(r'(?:减少|降低|压低|下降|换[^，。；]*?)\s*0(?:\.0+)?\s*(?:kW|千瓦)',text))
    paying=any(w in text for w in ('多花','多付','额外支付','增加费用'))
    return zero and paying or (paying and (delta is None or delta<=0 or gain is None or gain<=max(1.,.001*selection['metrics'][selection['preferred_candidate_id']]['upper_grid_peak_kw'])))


def evaluate_candidates(candidates,forecast,context,limits):
    from .tools import tool_config
    model=tool_config()['linear_model'];accepted=[i for i,r in enumerate(forecast['predictions']) if not r['abstain']]
    for c in candidates:
        peaks=[];base_peaks=[]
        for i in accepted:
            p,r,h=c['plan'][i],forecast['predictions'][i],context['hours'][i]
            factor=max(0.,1-model['load_fraction_per_degree']*(p['hvac_setpoint_c']-model['baseline_setpoint_c'])+model['precool_extra_fraction']*(p['action']=='precool'))
            peaks.append(max(0.,float(r['upper'])*factor-float(h['pv_kw'])-p['battery_kw']))
            base_peaks.append(max(0.,float(r['upper'])-float(h['pv_kw'])))
        upper=max(peaks) if peaks else None;base=max(base_peaks) if base_peaks else None
        cost=c['simulation'].get('estimated_cost');point=c['simulation'].get('estimated_peak_kw')
        c['objective_metrics']=dict(energy_cost_cny=cost,point_grid_peak_kw=point,upper_grid_peak_kw=upper,
            baseline_upper_grid_peak_kw=base,upper_peak_reduction_kw=base-upper if base is not None else None,
            comfort_degree_hours=c['simulation'].get('comfort_degree_hours'),accepted_hours=len(accepted),
            excluded_refused_hours=len(forecast['predictions'])-len(accepted),constraint_violations=0)
    ordered,minimum,tolerance=policy_order(candidates)
    # Merge displayed metric-equivalent proposals, retain policy winner per group.
    seen=set();distinct=[]
    for c in ordered:
        m=c['objective_metrics']
        key=tuple(round(m[k],1) if m[k] is not None else None for k in ('energy_cost_cny','upper_grid_peak_kw'))
        if key not in seen:seen.add(key);distinct.append(c)
    candidates[:]=[c for c in candidates if c in distinct]
    preferred=next(c for c in ordered if c in candidates)
    for c in candidates:c['selection_reason']=selection_reason(c,candidates,preferred)
    return preferred


def selection_reason(selected,candidates,preferred):
    def rounded(v):return round(v,1) if isinstance(v,float) else v
    metrics={c['candidate_id']:{k:rounded(v) for k,v in c['objective_metrics'].items()} for c in candidates}
    sel=metrics[selected['candidate_id']];costed=[c for c in candidates if c['objective_metrics']['energy_cost_cny'] is not None]
    cheapest=min(costed,key=lambda c:(c['objective_metrics']['energy_cost_cny'],c['candidate_id'])) if costed else None
    comparator=cheapest['candidate_id'] if cheapest else None;raw=selected['objective_metrics'];other=cheapest['objective_metrics'] if cheapest else None
    delta=round(raw['energy_cost_cny']-other['energy_cost_cny'],1) if other else None
    gain=round(other['upper_grid_peak_kw']-raw['upper_grid_peak_kw'],1) if other and raw['upper_grid_peak_kw'] is not None else None
    _,minimum,tolerance=policy_order(candidates)
    raw_gain=other['upper_grid_peak_kw']-raw['upper_grid_peak_kw'] if other and raw['upper_grid_peak_kw'] is not None else None
    if sel['upper_grid_peak_kw'] is None:text='全部低置信度，转交人工；没有可量化的调度收益。'
    elif selected['candidate_id']!=preferred['candidate_id']:
        text=f"此候选未按峰值容差及电费规则选中，上界峰值 {sel['upper_grid_peak_kw']:.1f} kW。"
        if sel['energy_cost_cny'] is not None:text+=f"电费 {sel['energy_cost_cny']:.1f} 元。"
    elif delta is not None and delta>0 and raw_gain is not None and raw_gain>tolerance:
        text=f"峰值差超过容差，为压低区间上界峰值多花 {delta:.1f} 元：相对最低电费方案减少 {gain:.1f} kW，上界峰值 {sel['upper_grid_peak_kw']:.1f} kW，电费 {sel['energy_cost_cny']:.1f} 元。"
    elif sel['energy_cost_cny'] is not None:
        text=f"峰值容差内视为相同并优先比较电费，上界峰值 {sel['upper_grid_peak_kw']:.1f} kW，电费 {sel['energy_cost_cny']:.1f} 元；不为不可见的峰值微差增加支出。"
    else:text=f"峰值容差内选择上界峰值 {sel['upper_grid_peak_kw']:.1f} kW；电费依据不完整，不报告电费差额。"
    if len(selected['plan'])==24:
        from .storage_planner import reserve_summary
        text='按完整窗口中通过门控的时段比较费用与峰值；拒绝小时不计费用。'+text+reserve_summary(selected['plan'])
    future_refused=[r for r in selected['plan'][1:] if r['action']=='human_review']
    if future_refused:
        from .storage_planner import chinese_hour
        text+='后续'+ '、'.join(chinese_hour(p['timestamp'],selected['plan'][0]['timestamp']) for p in future_refused)+'预测被拒绝，已保持设定且不充放电。'
        if selected['plan'][0]['action']!='human_review':text+='不影响当前通过门控的小时选案与执行。'
        text+='后续时段预测被拒绝，保留电量等值班人员复核后使用。'
    if selected['plan'][0].get('action')=='human_review':text+='当前小时预测被拒绝，零功率并转交人工。'
    return dict(policy=POLICY,selected_candidate_id=selected['candidate_id'],preferred_candidate_id=preferred['candidate_id'],
        objective_optimal=selected['candidate_id']==preferred['candidate_id'],metrics=metrics,compared_with_candidate_id=comparator,
        additional_cost_cny=delta,upper_peak_reduction_vs_cheapest_kw=gain,summary=text)
