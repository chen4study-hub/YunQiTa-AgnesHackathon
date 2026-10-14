"""Automatic log dispatch; optional provider cannot override abstentions."""
import math
from .tools import check_constraints, simulate_schedule
from .dispatch import dispatch

DEFAULT = dict(min_temp_c=24.0, max_temp_c=27.0, hvac_max_kw=50.0,
               battery_max_kw=500.0, battery_capacity_kwh=2000.0,
               initial_soc=0.5, min_soc=0.1, max_soc=0.95,
               price_per_kwh=0.8)


def rule_plan(forecast, constraints=None, provider=None):
    c = dict(DEFAULT)
    c.update(constraints or {})
    if not all(math.isfinite(v) for v in c.values()) or c['battery_capacity_kwh'] <= 0 or c['battery_max_kw'] < 0 or c['hvac_max_kw'] < 0 or not (0 <= c['min_soc'] <= c['initial_soc'] <= c['max_soc'] <= 1) or c['min_temp_c'] > c['max_temp_c']:
        raise ValueError('invalid equipment/comfort constraints')
    hold = (c['min_temp_c'] + c['max_temp_c']) / 2
    plan = []
    for row in forecast['predictions']:
        risk = row['abstain']
        plan.append(dict(timestamp=row['timestamp'], hvac_setpoint_c=hold, battery_kw=0.0,
                         action='human_review' if risk else 'hold',
                         reason=row['abstain_reason'] if risk else 'rule_fallback'))
    llm_status = {'mode':'mock','reason':'abstained_forecast' if any(p['abstain'] for p in forecast['predictions']) else 'provider_not_used'}
    # Provider can be plugged in later, but no unverified LLM output may bypass checks.
    if provider is not None and not any(p['abstain'] for p in forecast['predictions']):
        try:
            result = provider.propose(forecast, c)
            proposed = result['plan']
            llm_status = result.get('llm', {'mode':'real','reason':'call_succeeded'})
            if len(proposed) == len(plan) and [x['timestamp'] for x in proposed] == [x['timestamp'] for x in plan] and not check_constraints(proposed, c):
                plan = proposed
            else:
                llm_status = {'mode':'mock','reason':'constraint_rejected'}
        except Exception:  # provider outages / malformed proposals must never break safe fallback
            llm_status = {'mode':'mock','reason':'call_failed'}
    failures = check_constraints(plan, c)
    if failures:
        raise ValueError('unsafe fallback: ' + ', '.join(failures))
    human = any(p['action'] == 'human_review' for p in plan)
    for item in plan:
        dispatch({'building_id':forecast['building_id'],'model_version':forecast['model_version'],
                  'status':'handoff' if item['action']=='human_review' else 'executed','command':item,'llm':llm_status})
    text = ('存在低置信时段，已转交人工；通过门控的时段已下发至dispatch日志。' if human
            else '置信门控通过，指令已下发至dispatch日志。')
    text += ' LLM=' + llm_status['mode'] + ' (' + llm_status['reason'] + ')。'
    sim = simulate_schedule(plan, forecast, c)
    return dict(building_id=forecast['building_id'], model_version=forecast['model_version'],
                mode='auto', needs_human=human, plan=plan,
                estimated_cost=sim['estimated_cost'], estimated_savings=sim['estimated_savings'],
                explanation=text, llm=llm_status)
