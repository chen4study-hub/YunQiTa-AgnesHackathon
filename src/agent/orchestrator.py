"""Deterministic candidate tools, bounded LLM choice, grounded log-only dispatch."""
import math
import copy
import re
from datetime import datetime
from typing import Literal
from pydantic import BaseModel,ConfigDict,Field
from .tools import tool_config,check_constraints,simulate_schedule,explain_uncertainty
from .dispatch import dispatch_to_bms
from .provider import OpenAICompatibleProvider
from .selection import evaluate_candidates,misleading_tradeoff
from .numeric_prompt import numeric_instruction
from .storage_planner import rolling_candidate,unique_candidates
from .temperature_planner import optimize_temperature,control_metrics
from .manual_reference import build_manual_reference
from .display_text import DISPLAY_INSTRUCTION,unit_text,public_text,display_evidence,numeric_tokens,number_text


class Choice(BaseModel):
    model_config=ConfigDict(extra='forbid')
    candidate_id:str
    reason:str=Field(min_length=1)


class Command(BaseModel):
    model_config=ConfigDict(extra='forbid')
    timestamp:str
    hvac_setpoint_c:float=Field(ge=24,le=27,allow_inf_nan=False)
    battery_kw:float=Field(ge=-500,le=500,allow_inf_nan=False)
    action:str
    source:str
    prepared_upper_kw:float=Field(ge=0,allow_inf_nan=False)
    reason:str


class Result(BaseModel):
    model_config=ConfigDict(extra='forbid')
    building_id:str
    source:str
    plan:list[Command]
    work_orders:list[dict]
    manual_reference:list[dict]
    selected:str|None
    reason:str
    candidates:list[dict]
    llm:dict
    receipt:dict
    selection_reason:dict
    explanation_source:Literal['llm','template']='template'


def ungrounded_numbers(reason,tool_outputs):
    """Return exact tokens absent from the numeric evidence, for corrective feedback."""
    allowed=[]
    def walk(value):
        if isinstance(value,bool):return
        if isinstance(value,(int,float)) and math.isfinite(value):allowed.append(float(value))
        elif isinstance(value,dict):
            for v in value.values():walk(v)
        elif isinstance(value,list):
            for v in value:walk(v)
    walk(tool_outputs)
    tokens=numeric_tokens(reason)
    def supported(token):
        try:value=float(token)
        except ValueError:return False
        return any(abs(value-a)<=1e-7 for a in allowed)
    return list(dict.fromkeys(s for s in tokens if not supported(s)))


def check_grounding(reason,tool_outputs):
    return not ungrounded_numbers(reason,tool_outputs)


def rounded_tools(value):
    if isinstance(value,float):return round(value,1)
    if isinstance(value,dict):return {k:rounded_tools(v) for k,v in value.items()}
    if isinstance(value,list):return [rounded_tools(v) for v in value]
    return value


ENGLISH_ACTIONS=re.compile(r'\b(?:hold|dispatch|precool|human_review)\b',re.I)


def chinese_reason(text):
    return unit_text(text.replace('SOC','电量'))


def reason_format_invalid(text):
    return bool(re.search(r'[A-Za-z]',re.sub(r'(?<=\d) (?:kWh|kW|°C)(?![A-Za-z])','',chinese_reason(text))))


def candidate_evidence(candidates):
    """Human-readable tool view; full-precision control candidates remain untouched."""
    view=rounded_tools(candidates)
    names={'hold':'保持设定','dispatch':'储能调度','precool':'提前预冷','human_review':'转人工'}
    for candidate in view:
        for p in candidate['plan']:
            p['action']=names[p['action']]
            p['reason']=number_text(f"按区间上界 {p['prepared_upper_kw']:.1f} kW准备，储能功率 {p['battery_kw']:.1f} kW。")
    return view


def work_order(row):
    explanation=explain_uncertainty({'predictions':[row]})[0]
    return dict(timestamp=row['timestamp'],source='rule',possible_reasons=explanation['reasons'],
        evidence=explanation['evidence'],suggested_checks=['核对表计与历史负荷','核对天气及区间宽度','确认人员与设备运行记录'],
        conservative_default={'hvac_setpoint_c':25.5,'battery_kw':0.,'action':'human_review'})


def schedule_candidate(forecast,context,limits,candidate_id,scale=1.):
    """Valley charge; peak shave against upper interval; preceding-hour precooling1C."""
    predictions=forecast['predictions'];hours=context['hours']
    if len(predictions)!=len(hours):raise ValueError('Context/forecast horizon mismatch')
    soc=limits['initial_soc'];plan=[]
    threshold=limits.get('peak_target_kw',800.)
    for i,(row,h) in enumerate(zip(predictions,hours)):
        a=datetime.fromisoformat(row['timestamp'].replace('Z','+00:00'))
        b=datetime.fromisoformat(h['timestamp'].replace('Z','+00:00'))
        if a!=b:raise ValueError('Context timestamp mismatch')
        refused=row['abstain'];power=0.;temp=25.5;action='hold'
        if not refused:
            if h['tariff_period']=='valley':
                power=-min(500.,limits['battery_max_kw'],100.*scale,
                    max(0.,(limits['max_soc']-soc)*limits['battery_capacity_kwh']))
            elif h['tariff_period']=='peak':
                need=max(0.,float(row['upper'])-float(h['pv_kw'])-threshold)
                power=min(500.,limits['battery_max_kw'],need*scale,
                    max(0.,(soc-limits['min_soc'])*limits['battery_capacity_kwh']))
            if i+1<len(predictions) and not predictions[i+1]['abstain'] and predictions[i+1]['upper']>threshold:
                temp=24.5;action='precool'
            elif power:action='dispatch'
        else:action='human_review'
        soc-=power/limits['battery_capacity_kwh']
        plan.append(dict(timestamp=row['timestamp'],hvac_setpoint_c=temp,battery_kw=power,
            action=action,source='rule',prepared_upper_kw=float(row['upper']),
            reason=f"按区间上界 {float(row['upper']):.1f} kW准备，储能功率 {power:.1f} kW。"))
    return dict(candidate_id=candidate_id,plan=plan)


def run_agent(forecast,context,constraints=None,provider=None,dispatch_path='logs/dispatch.jsonl',dispatch_current_only=False,dispatch_enabled=True,takeover_date=None,frozen_agent=None):
    limits={**tool_config()['equipment'],**(constraints or {})}
    limits['min_temp_c']=max(24.,limits['min_temp_c']);limits['max_temp_c']=min(27.,limits['max_temp_c'])
    limits['battery_max_kw']=min(500.,limits['battery_max_kw'])
    limits['min_soc']=max(.1,limits['min_soc']);limits['max_soc']=min(.95,limits['max_soc'])
    from .takeover import plan_records,overlay
    initial_takeovers=plan_records(forecast,takeover_date) if takeover_date is not None else {}
    current_refused=forecast['predictions'][0]['abstain']
    orders=[work_order(r) for r in forecast['predictions'] if r['abstain']]
    candidates=[];baseline_candidates=[]
    if frozen_agent is not None:candidates=copy.deepcopy(frozen_agent["candidates"])
    # Fixed host battery alternatives; every candidate gets hourly temperature optimization.
    for name,scale in ([] if frozen_agent is not None else [('rule_full',1.),('rule_conservative',.5),('rule_hold',0.)]):
        candidate=(rolling_candidate if len(forecast['predictions'])==24 else schedule_candidate)(forecast,context,limits,name,scale)
        if name=='rule_hold':
            for p in candidate['plan']:
                p.update(hvac_setpoint_c=25.5,battery_kw=0.,action='human_review' if p['action']=='human_review' else 'hold')
        from .zone_comfort import enforce_plan
        enforce_plan(candidate['plan'],forecast['predictions'],context['hours'],limits)
        if not check_constraints(candidate['plan'],limits):
            baseline=copy.deepcopy(candidate)
            metrics=control_metrics(baseline['plan'],forecast['predictions'],context['hours'])
            complete=all(h.get('outdoor_temp_c') is not None for r,h in zip(forecast['predictions'],context['hours']) if not r['abstain'])
            baseline['simulation']={'estimated_cost':metrics['energy_cost_cny'] if complete else None,
                                    'estimated_peak_kw':metrics['point_grid_peak_kw'] if complete else None}
            baseline_candidates.append(baseline)
        optimize_temperature(candidate,forecast,context,limits)
        if check_constraints(candidate['plan'],limits):continue
        accepted=[(p,r,h) for p,r,h in zip(candidate['plan'],forecast['predictions'],context['hours']) if not r['abstain']]
        if accepted and any(h.get('outdoor_temp_c') is None for p,r,h in accepted):
            simulation={'estimated_cost':None,'estimated_savings':None,'reason':'complete observed context unavailable'}
        elif accepted:
            simulation=simulate_schedule([p for p,r,h in accepted],
                {'predictions':[r for p,r,h in accepted]},limits,{'hours':[h for p,r,h in accepted]})
        else:simulation={'estimated_cost':None,'reason':'all hours refused'}
        candidate['simulation']=simulation;candidates.append(candidate)
    # Individual improvement alone cannot prevent a tolerance-band winner switch
    # from increasing cost or point peak. Guard against the old policy winner too.
    if baseline_candidates:
        baseline=evaluate_candidates(unique_candidates(baseline_candidates),forecast,context,limits)
        caps=baseline['objective_metrics']
        def no_selection_regression(candidate):
            metrics=candidate['temperature_optimization']['after']
            return all(caps[key] is None or metrics[key]<=caps[key]+1e-7 for key in metrics)
        for candidate in candidates:
            candidate['temperature_optimization']['selection_guard_passed']=no_selection_regression(candidate)
            candidate['temperature_optimization']['selection_guard_caps']={key:caps[key] for key in candidate['temperature_optimization']['after']}
    if frozen_agent is None:candidates=unique_candidates(candidates)
    if not candidates:raise ValueError('No constraint-valid rule candidate')
    manual_reference=(copy.deepcopy(frozen_agent.get('manual_reference',[])) if frozen_agent is not None
        else build_manual_reference(forecast,context,limits))
    if frozen_agent is not None:
        selected=next(c for c in candidates if c['candidate_id']==frozen_agent['selected'])
    else:selected=evaluate_candidates(candidates,forecast,context,limits)
    source='rule'
    upper=round(max(float(r['upper']) for r in forecast['predictions']),1)
    tool_forecast=rounded_tools(forecast);tool_candidates=candidate_evidence(candidates)
    origin=forecast['predictions'][0]['timestamp']
    evidence=display_evidence({'forecast':tool_forecast,'candidates':tool_candidates},origin)
    if frozen_agent is not None:
        evidence['current_control']={'storage_power_kw':round(abs(selected['plan'][0]['battery_kw']),1)}
    rule_reason=f'按区间上界 {upper:.1f} kW准备。'+selected['selection_reason']['summary']
    if frozen_agent is not None:
        from .exported_schedule import control_text,frozen_prose
        rule_reason=control_text(selected['plan'][0])+selected['selection_reason']['summary']
    if not check_grounding(rule_reason,evidence):raise ValueError('Rule selection not grounded')
    reason=rule_reason
    number_prompt=numeric_instruction(evidence)
    llm_status={'mode':'rule','reason':'refused_current' if current_refused else 'validation_fallback'}
    # Future refusal is planner safety, NOT a current-hour LLM/handoff gate.
    if not current_refused and origin not in initial_takeovers:
        provider=provider or OpenAICompatibleProvider()
        feedback=''
        for attempt in range(2):
            try:
                response=provider.choose_candidate(tool_forecast,tool_candidates,
                    (f'Respect selection_reason.preferred_candidate_id (computed full precision); do not choose a worse candidate. Use supplied selection_reason.summary to quantify cost/peak tradeoff. Never claim extra cost buys zero peak reduction. Select an existing candidate and write1-2 Chinese sentences explaining why and what it does. The host template supplies the upper bound; you need not repeat it. All prose Chinese except standardized units; do not expose internal field names or English phrases. Use only supplied numeric values, at most1 decimal. Describe actions in Chinese, never hold/dispatch/precool/human_review. No shadow/simulation/estimate wording; no invented savings.' if attempt==0 else
                    f'Rewrite candidate_id/reason:1-2 Chinese sentences about selection and actions, the host template supplies the upper bound; every number you choose to use must match supplied rounded tool values. {feedback} Describe actions in Chinese, never hold/dispatch/precool/human_review. No invented savings or shadow/simulation/estimate wording.')+' Delete the entire sentence describing identifier ranking; never mention 编号 or sorting order. Use 在峰值允许范围内 instead of 峰值容差带/容差带内; never mention 容差. Explain the selected action and sourced cost/peak only.'
                    +(f' Decision is locked to {selected["candidate_id"]}; do not select another candidate. Write only a brief nonnumeric operational sentence. The host supplies all control, direction, power, cost and peak facts.' if frozen_agent is not None else '')
                    +DISPLAY_INSTRUCTION+number_prompt)
                llm_status=response['llm']
                if llm_status.get('reason') in ('call_failed','key_unavailable'):
                    break  # keep host-selected objective, transport metadata and rule source
                choice=Choice.model_validate(response['choice'])
                from .prose_repair import repair_prose
                match=next(c for c in candidates if c['candidate_id']==choice.candidate_id)
                if frozen_agent is not None:
                    if match['candidate_id']!=selected['candidate_id']:
                        feedback='Decision is locked; retain the supplied selected candidate.'
                        llm_status={'mode':'rule','reason':'locked_choice_failed'};continue
                    choice.reason=frozen_prose(choice.reason)
                choice.reason,repair=repair_prose(choice.reason,origin,evidence,match['selection_reason'])
                date_invalid=not choice.reason
                missing=ungrounded_numbers(choice.reason,evidence)
                if missing:date_invalid=True
                # Ground numeric prose BEFORE template fallback; display conversion only
                # normalizes units or verifies/replaces calendar tokens, never power/cost.
                # Presentation defects must not discard an otherwise valid host-optimal choice.
                template_prose=bool(misleading_tradeoff(choice.reason,match['selection_reason']) or date_invalid or any(w in choice.reason for w in ('影子','模拟','估算')) or
                    re.search(r'\d+\.\d{2,}',choice.reason) or ENGLISH_ACTIONS.search(choice.reason) or reason_format_invalid(choice.reason))
                if frozen_agent is None and not match['selection_reason']['objective_optimal']:
                    feedback='Choice violates stated objective. Select selection_reason.preferred_candidate_id; no invented peak penalty.'
                    llm_status={'mode':'rule','reason':'objective_choice_failed'};continue
                selected=match
                prose='选择已通过约束与目标检查的候选。' if template_prose else choice.reason
                reason=f'按区间上界 {upper:.1f} kW准备。'+prose+' '+match['selection_reason']['summary']
                if frozen_agent is not None:
                    reason=rule_reason if template_prose else control_text(selected['plan'][0])+prose+' '+match['selection_reason']['summary']
                llm_status={**llm_status,'prose_repair':repair,'explanation_mode':'template' if template_prose else 'llm_with_template_upper'}
                if not check_grounding(reason,evidence):raise ValueError('Selection not grounded')
                source='rule' if response['llm'].get('reason') in ('call_failed','key_unavailable') else 'llm' if response['llm']['mode']=='real' else response['llm']['mode'];break
            except Exception:
                feedback='Invalid choice schema or candidate_id. Return an available candidate_id and a Chinese reason.'
                llm_status={'mode':'rule','reason':'output_validation_failed'};continue
    reason=public_text(reason,origin,evidence)
    if not check_grounding(reason,evidence):raise ValueError('Display reason not grounded')
    # Final renderer covers nested live wording as well as the main reason.
    for candidate in candidates:
        candidate['selection_reason']['summary']=public_text(candidate['selection_reason']['summary'],origin,evidence)
        for command in candidate['plan']:command['reason']=public_text(command['reason'],origin,evidence)
    for order in orders:
        for key in ('possible_reasons','suggested_checks'):
            order[key]=[public_text(s,origin,evidence) for s in order[key]]
    validated=Result(building_id=forecast['building_id'],source=source,plan=selected['plan'],work_orders=orders,manual_reference=manual_reference,
        selected=selected['candidate_id'],reason=reason,candidates=candidates,llm=llm_status,selection_reason=selected['selection_reason'],
        explanation_source='llm' if source=='llm' and llm_status.get('explanation_mode')=='llm_with_template_upper' else 'template',
        receipt={'count':0,'elapsed_ms':0.,'transport':'log_only','device_connected':False})
    accepted=[p.model_dump() for p in validated.plan if p.action!='human_review']
    if frozen_agent is not None:
        from src.data.replay_payload import display_precision
        accepted=display_precision(accepted)
    if dispatch_current_only:
        accepted=[p for p in accepted if p['timestamp']==forecast['predictions'][0]['timestamp']]
    # Fresh cancellation/version lookup at the final dispatch boundary. Never dispatch
    # first then merely relabel a receipt as manual. DB failures stop execution.
    records=plan_records(forecast,takeover_date) if takeover_date is not None else {}
    accepted=[p for p in accepted if p['timestamp'] not in records]
    if accepted and dispatch_enabled:validated.receipt=dispatch_to_bms(accepted,forecast['building_id'],dispatch_path)
    result=validated.model_dump()
    result=overlay(result,records,origin) if takeover_date is not None else result
    if frozen_agent is not None:
        result=display_precision(result)
        result['decision_source']='exported_hour'
    return result
