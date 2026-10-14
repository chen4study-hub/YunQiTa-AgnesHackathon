"""Question-scoped prompt view; full traces remain available for validation/audit."""
import copy
from .orchestrator import rounded_tools
from .numeric_prompt import MEANINGS


def compact_evidence(trace):
    out=[]
    for t in trace:
        name=t['tool'];r=copy.deepcopy(t['result'])
        if name=='selection_reason':
            keys=['selected_candidate_id','preferred_candidate_id','objective_optimal','compared_with_candidate_id','additional_cost_cny','upper_peak_reduction_vs_cheapest_kw','horizon_hours','estimated_savings']
            r={k:r[k] for k in keys if k in r}|{'metrics':{k:v for k,v in r.get('metrics',{}).items() if k in (r.get('selected_candidate_id'),r.get('compared_with_candidate_id'))}}
        elif name=='get_weather':
            r={'scope':r['scope'],'hours':[{k:h.get(k) for k in ('timestamp','outdoor_temp_c','humidity_percent')} for h in r['hours']]}
        elif name=='handoff_reason':r={k:r[k] for k in ['current_handoff','abstain_reason','active_takeover','record_text_values'] if k in r}
        elif name in ['simulate_schedule_before','simulate_schedule_after','get_context_scenario','get_forecast']:continue
        if name=='execution_receipt' and isinstance(r,dict):r['dispatch_target']='BA/EMS';r['receipt_kind']='下发日志回执'
        out.append({'tool':name,'result':r})
    return rounded_tools(out)


def required_items(result):
    trace=compact_evidence(result['tool_trace']);labels={}
    def walk(obj):
        if isinstance(obj,dict):
            for k,v in obj.items():
                if isinstance(v,(int,float)) and not isinstance(v,bool):labels.setdefault(round(v,1),[]).append(MEANINGS.get(k,k))
                elif isinstance(v,(dict,list)):walk(v)
        elif isinstance(obj,list):
            for v in obj:walk(v)
    walk(trace)
    fields={
        'execution_receipt':['count','elapsed_ms'],
        'hvac_compare':['before_setpoint_c','after_setpoint_c','before_cost','after_cost','savings_cny','accepted_hours','excluded_hours','before_peak_kw','after_peak_kw','peak_increase_kw'],
        'selection_reason':['upper_grid_peak_kw','energy_cost_cny','estimated_savings'],
        'current_state':['soc_percent','hvac_setpoint_c','outdoor_temp_c'],
        'current_energy':['pv_kw','grid_kw','battery_kw'],
    }.get(result['selected_tool'])
    if fields and trace:
        fields=result.get('required_fields') or fields
        values=trace[-1]['result']
        if result['selected_tool']=='hvac_compare' and values.get('savings_cny') is not None and values['savings_cny']<0:
            fields=['extra_cost_cny' if k=='savings_cny' else k for k in fields]
        if result['selected_tool']=='hvac_compare' and values.get('peak_reduction_kw',0)>0:
            fields=['peak_reduction_kw' if k=='peak_increase_kw' else k for k in fields]
        if result['selected_tool']=='selection_reason':values={**values.get('metrics',{}).get(values.get('selected_candidate_id'),{}),'estimated_savings':values.get('estimated_savings')}
        return [{'field':k,'value':round(values[k],1),'meaning':MEANINGS[k]} for k in fields if values.get(k) is not None]
    return [{'value':v,'meaning':' / '.join(dict.fromkeys(labels.get(round(v,1),['工具必需值'])))} for v in result.get('required_values',[])]


def prompt_view(evidence):
    view=copy.deepcopy(evidence)
    clocks=view.pop('timestamp_clocks',[])
    view['clock_values']=sorted({v for c in clocks for k,v in c.items() if k in ('hour','minute')})
    return view


def selection_reference(r):
    metrics=r.get('metrics',{}).get(r.get('selected_candidate_id'),{})
    if any(metrics.get(k) is None for k in ('upper_grid_peak_kw','energy_cost_cny')):return r['summary']
    label={'rule_full':'全额调度','rule_conservative':'保守调度','rule_hold':'保持设定'}.get(r.get('selected_candidate_id'),'当前方案')
    text=f"选用{label}，负荷偏高时的电网峰值为 {metrics['upper_grid_peak_kw']:.1f} kW，电费为 {metrics['energy_cost_cny']:.1f} 元。"
    savings=r.get('estimated_savings')
    if savings is not None:
        text+=(f"相对保持原运行方式的基准，预计节省 {savings:.1f} 元。" if savings>=0 else
            f"相对基准的电费差额为 {savings:.1f} 元，负值表示电费增加。")
    text+='仅比较可自动调度的时段，未计入的小时不计电费。'
    return text


def short_reference(result):
    return result['answer']


def required_instruction(items):
    return 'Required answer values (include ALL, with their meanings, do not compute new numbers): '+ '; '.join(f"{i['meaning']}={i['value']:g}" for i in items)
