"""Hash-hydrated hourly decisions are authoritative; no second optimization."""
import copy
from datetime import datetime
from .rolling_context import from_replay
from .tools import check_constraints,tool_config

ACTIONS={'保持设定':'hold','储能调度':'dispatch','提前预冷':'precool','转人工':'human_review'}


def exported_inputs(data,row,constraints=None):
    """Recover pre-command SOC for validation, NOT for a new candidate search.

    storage.soc is the exported end-of-hour state. Exact evidence is hydrated by
    replay_hour before entry; rounded display values must not drive validation.
    """
    agent=copy.deepcopy(row['agent'])
    capacity=tool_config()['equipment']['battery_capacity_kwh']
    before=row['storage']['soc']+row['storage']['power_kw']/capacity
    forecast,context,limits=from_replay(data,row,before)
    for key in ('initial_soc','battery_capacity_kwh','peak_target_kw'):
        if constraints and key in constraints and constraints[key]!=limits.get(key):
            raise ValueError('requested planning basis differs from locked export')
    limits.update(constraints or {})
    limits['initial_soc']=before
    ids=[c['candidate_id'] for c in agent['candidates']]
    if len(ids)!=len(set(ids)) or agent['selected'] not in ids:
        raise ValueError('invalid exported selection')
    if agent['selection_reason']['selected_candidate_id']!=agent['selected']:
        raise ValueError('exported selection evidence mismatch')
    for candidate in agent['candidates']:
        plan=candidate['plan']
        if [p['timestamp'] for p in plan]!=[p['timestamp'] for p in forecast['predictions']]:
            raise ValueError('exported plan/window mismatch')
        for command,prediction in zip(plan,forecast['predictions']):
            command['action']=ACTIONS.get(command['action'],command['action'])
            if prediction['abstain']!=(command['action']=='human_review'):
                raise ValueError('exported refusal mismatch')
        if check_constraints(plan,limits):
            raise ValueError('exported controls violate requested constraints')
        from src.data.replay_payload import display_precision
        for command in display_precision(plan):
            if (abs(command['battery_kw'])>min(500.,limits['battery_max_kw'])
                    or not max(24.,limits['min_temp_c'])<=command['hvac_setpoint_c']<=min(27.,limits['max_temp_c'])):
                raise ValueError('exported display command violates requested constraints')
    selected=next(c for c in agent['candidates'] if c['candidate_id']==agent['selected'])
    current=selected['plan'][0]
    if (current['timestamp']!=row['t'] or current['battery_kw']!=row['storage']['power_kw']
            or current['hvac_setpoint_c']!=agent['hvac_setpoint_c']):
        raise ValueError('exported current control/storage mismatch')
    # A mismatched snapshot must fail closed, not silently fall back to live math.
    if datetime.fromisoformat(current['timestamp']).tzinfo is None:
        raise ValueError('exported origin has no timezone')
    return forecast,context,limits,agent


def control_text(command):
    power=command['battery_kw']
    mode='充电' if power<0 else '放电' if power>0 else '待机'
    return f"空调设定 {command['hvac_setpoint_c']:.1f} °C，储能{mode} {abs(power):.1f} kW。"


def frozen_prose(text):
    """The host supplies ALL numeric/control/metric facts for a locked decision."""
    import re
    from .display_text import numeric_tokens
    return ''.join(s for s in re.split(r'(?<=[。！？!?；;\n])',text)
        if not numeric_tokens(s) and not re.search(r'空调|设定|储能|电池|充电|放电|待机|电量|电费|节省|多花|费用|成本|功率|温度|千瓦|摄氏|[零一二三四五六七八九十百千万]+(?:度|元|瓦)',s)
        and ('峰值' not in s or re.search(r'峰值(?:容差带|允许范围)',s)))
