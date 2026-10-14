"""Upper-bound recommendations for operator confirmation, never dispatch commands."""
import copy
from datetime import datetime, timedelta
from .storage_planner import rolling_candidate
from .temperature_planner import optimize_temperature
from .tools import check_constraints


def build_manual_reference(forecast, context, limits):
    refused = [r['abstain'] for r in forecast['predictions']]
    if not any(refused):
        return []
    conservative = copy.deepcopy(forecast)
    for r in conservative['predictions']:
        r['abstain'] = False
        r['point'] = float(r['upper'])
    # Independent full window, initial SOC and terminal reserve remain enforced.
    candidate = rolling_candidate(conservative, context, limits, 'manual_reference', .5, allow_prepeak_charge=True)
    optimize_temperature(candidate, conservative, context, limits)
    if check_constraints(candidate['plan'], limits):
        raise ValueError('invalid manual reference')
    reference_soc = limits['initial_soc']; soc_before = []; soc_after = []
    for p in candidate['plan']:
        soc_before.append(reference_soc)
        reference_soc -= p['battery_kw']/limits['battery_capacity_kwh']
        soc_after.append(reference_soc)
    rows = []; i = 0
    while i < len(refused):
        if not refused[i]:
            i += 1
            continue
        start = i
        while (i < len(refused) and refused[i] and (i == start or
               datetime.fromisoformat(forecast['predictions'][i]['timestamp']) ==
               datetime.fromisoformat(forecast['predictions'][i-1]['timestamp'])+timedelta(hours=1))):
            i += 1
        end = i
        segment_start = candidate['plan'][start]['timestamp']
        segment_end = (datetime.fromisoformat(candidate['plan'][end-1]['timestamp'])+timedelta(hours=1)).isoformat()
        for j in range(start, end):
            p = candidate['plan'][j]; power = p['battery_kw']
            mode = 'discharge' if round(power,1)>0 else 'charge' if round(power,1)<0 else 'idle'
            available=max(0.,soc_before[j]-limits['min_soc'])*limits['battery_capacity_kwh']
            peak_indices=[]
            for q in range(j,len(context['hours'])):
                if context['hours'][q]['tariff_period']=='peak':peak_indices.append(q)
                elif peak_indices:break
            peak_need=sum(max(0.,candidate['plan'][q]['battery_kw']) for q in peak_indices)
            if mode=='discharge':
                basis=f"峰段放电{power:,.0f} kW，留电{max(0.,soc_after[j]-limits['min_soc'])*limits['battery_capacity_kwh']:,.0f} kWh"
            elif mode=='charge':
                basis=f"峰前补电{-power:,.0f} kW，峰段计划用{peak_need:,.0f} kWh"
            elif available<limits['battery_capacity_kwh']*.02:
                basis=f"电量{soc_before[j]*100:.0f}%，下限{limits['min_soc']*100:.0f}%，可放{available:,.0f} kWh，待机"
            elif peak_indices:
                basis=f"可用{available:,.0f} kWh，峰段计划用{peak_need:,.0f} kWh，待机"
            else:
                basis=f"可用{available:,.0f} kWh，后续无峰段，待机"
            temp=p['hvac_setpoint_c']
            temperature_reason=(f"预冷{temp:.1f} °C" if temp<25.5 else
                                f"{'峰段上调' if context['hours'][j]['tariff_period']=='peak' else '舒适放宽'}{temp:.1f} °C" if temp>25.5 else f"舒适保持{temp:.1f} °C")
            if temp==25.5 and mode=='idle':
                temperature_reason=f"保持25.5 °C，电量{soc_before[j]*100:.0f}%"
            reason=temperature_reason+'；'+basis+'；值班员核对确认。'
            if len(reason)>60:raise ValueError('manual reason exceeds 60 characters')
            rows.append(dict(timestamp=p['timestamp'], hvac_setpoint_c=p['hvac_setpoint_c'],
                storage_mode=mode, battery_kw=power, suggested_duration_hours=end-start,
                remaining_duration_hours=end-j, segment_start=segment_start, segment_end=segment_end,
                prepared_upper_kw=p['prepared_upper_kw'], requires_confirmation=True,
                reference_soc_before=soc_before[j], reference_soc_after=soc_after[j],
                reason=reason))
    return rows


def manual_reference_at(agent, date, hour):
    """Return a copied reference by site-local ISO date and integer hour; else None.

    Duplicate local hours (DST) are ambiguous and rejected, not silently selected.
    """
    if isinstance(hour, bool) or not isinstance(hour, int) or not 0<=hour<=23:
        raise ValueError('hour must be an integer in 0..23')
    day = datetime.strptime(date, '%Y-%m-%d').date()
    matches = [r for r in agent.get('manual_reference', [])
               if datetime.fromisoformat(r['timestamp']).date()==day and
               datetime.fromisoformat(r['timestamp']).hour==hour]
    if len(matches)>1:
        raise ValueError('ambiguous local hour; use timestamp')
    return copy.deepcopy(matches[0]) if matches else None


def align_export_segments(data):
    """Align reference durations with actual exported hourly handoff states.

    Forecast-window refusal runs are not the displayed day handoff runs.
    Outside exported dates, retain the original window-local segment metadata.
    """
    hours=sorted(data['hours'],key=lambda r:datetime.fromisoformat(r['t']))
    segments={}; states={r['t']:r['agent']['status']=='handoff' for r in hours}
    i=0
    while i<len(hours):
        if not states[hours[i]['t']]:
            i+=1;continue
        start=i;i+=1
        while i<len(hours) and states[hours[i]['t']] and (
            datetime.fromisoformat(hours[i]['t'])==datetime.fromisoformat(hours[i-1]['t'])+timedelta(hours=1)):
            i+=1
        end=i
        for j in range(start,end):
            segments[hours[j]['t']]=dict(suggested_duration_hours=end-start,
                remaining_duration_hours=end-j,segment_start=hours[start]['t'],
                segment_end=(datetime.fromisoformat(hours[end-1]['t'])+timedelta(hours=1)).isoformat())
    for row in hours:
        refs=row['agent'].get('manual_reference')
        if refs is None:continue
        refs[:]=[r for r in refs if r['timestamp'] not in states or states[r['timestamp']]]
        for ref in refs:
            if ref['timestamp'] in segments:ref.update(segments[ref['timestamp']])
    return data
