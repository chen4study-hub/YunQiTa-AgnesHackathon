"""Read-only hourly tariff comparison. Billing basis is explicit, not net-grid billing."""
import re
from .tools import tool_config

LABELS = {'peak': '峰时', 'flat': '平时', 'valley': '谷时'}


def period_question(question):
    return bool(re.search(r'电价|分时电费|分时电价|(?:时段|时候|几点|什么时候|何时|哪个小时).*?(?:电费|最贵|最便宜)|(?:电费|用电).*?(?:最贵|最便宜|哪个时段|什么时候)', question)) and not re.search(r'改.*温|调.*温|空调.*(?:改|调|降低|升高)', question)


def comparison(question, ops, source, date, clock, parameters):
    tariff = tool_config()['tariff']
    def rate(hour):
        period = 'valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
        return period, tariff[period]
    if re.search(r'(?:现在|当前|此刻|这会儿).*?电价|电价.*?(?:现在|当前|此刻)', question):
        hour = int(clock[:2]); period, price = rate(hour)
        steps = next(i for i in range(1, 25) if rate((hour+i)%24) != (period, price))
        target = hour+steps; next_period, next_price = rate(target%24)
        stamp = ('次日 ' if target>=24 else '')+f'{target%24:02d}:00'
        text = f'现在 {clock} 是{LABELS[period]}电价 {price:.2f} 元/kWh；下一档从 {stamp} 开始，是{LABELS[next_period]}电价 {next_price:.2f} 元/kWh。'
        return text, {'source': source, 'tariff_source': 'configs/agent_tools.json', 'date': date, 'as_of': clock,
                      'scope_name': '当前电价及下一档', 'period': period, 'period_name': LABELS[period],
                      'price_cny_per_kwh': price, 'price_text': f'{price:.2f} 元/kWh',
                      'next_start_time': stamp, 'next_period_name': LABELS[next_period],
                      'next_price_cny_per_kwh': next_price, 'next_price_text': f'{next_price:.2f} 元/kWh'}
    start, end = parameters.get('start_hour', 0), parameters.get('end_hour', 24)
    if 'start_hour' not in parameters and 'end_hour' not in parameters:
        if '下午' in question: start, end = 12, 18
        elif any(w in question for w in ('晚上', '今晚')): start, end = 18, 24
        elif '上午' in question: start, end = 6, 12
        if any(w in question for w in ('剩余', '接下来')): start = max(start, int(clock[:2]))
    if start >= end: raise ValueError('empty tariff range')
    rows = []
    for h in ops['hours']:
        hour = h['offset_ms']//3600000
        if not start <= hour < end: continue
        period = 'valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
        power = h['storage']['power_kw']
        rows.append({'hour': hour, 'start_time': f'{hour:02d}:00', 'end_time': f'{hour+1:02d}:00',
                     'period': period, 'period_name': LABELS[period],
                     'price_cny_per_kwh': tariff[period], 'price_text': f'{tariff[period]:.2f} 元/kWh',
                     'building_load_kw': h['actual_kw'], 'grid_kw': h['grid_kw'],
                     'hour_energy_kwh': h['energy']['hour_kwh']['actual_kwh'],
                     'hour_cost_cny': h['energy']['hour_cost_cny'], 'storage_kw': power,
                     'storage_action_name': '放电' if power > 0 else '充电' if power < 0 else '不充不放',
                     'completed': h['offset_ms']+3600000 <= int(clock[:2])*3600000+int(clock[3:])*60000})
    if len(rows) != end-start: raise ValueError('incomplete tariff coverage')
    # Ops publishes gross building energy * configured price. Verify rather than
    # silently relabel this as meter settlement or cost after storage/PV deductions.
    if any(abs(r['hour_energy_kwh']*r['price_cny_per_kwh']-r['hour_cost_cny']) > .11 for r in rows):
        raise ValueError('hourly cost basis mismatch')
    highest = max(r['price_cny_per_kwh'] for r in rows); lowest = min(r['price_cny_per_kwh'] for r in rows)
    costly = max(rows, key=lambda r: r['hour_cost_cny']); cheapest = min(rows, key=lambda r: r['hour_cost_cny'])
    def slot(r): return r['start_time']+'–'+r['end_time']
    def spans(items):
        groups = []
        for item in items:
            if groups and item['hour'] == groups[-1][-1]['hour']+1:
                groups[-1].append(item)
            else: groups.append([item])
        return '、'.join(g[0]['start_time']+'–'+g[-1]['end_time'] for g in groups)
    high_slots = spans([r for r in rows if r['price_cny_per_kwh'] == highest])
    low_slots = spans([r for r in rows if r['price_cny_per_kwh'] == lowest])
    if highest == lowest:
        text = f'按已配置分时电价，{start:02d}:00–{end:02d}:00 都是{rows[0]["period_name"]}电价 {highest:.2f} 元/kWh。'
    else:
        text = f'按已配置分时电价，{high_slots} 单价最高，为 {highest:.2f} 元/kWh；{low_slots} 最便宜，为 {lowest:.2f} 元/kWh。'
    text += f'按整栋小时用电量比较，{slot(costly)} 电费最高，为 {costly["hour_cost_cny"]:,.1f} 元；{slot(cheapest)} 电费最低，为 {cheapest["hour_cost_cny"]:,.1f} 元。'
    text += f'{slot(costly)} 是{costly["period_name"]}电价 {costly["price_cny_per_kwh"]:.2f} 元/kWh，用电 {costly["hour_energy_kwh"]:,.1f} kWh；单价和用电量共同决定费用，所以这段电费最高。'
    text += f'这段储能{costly["storage_action_name"]} {abs(costly["storage_kw"]):,.1f} kW；储能放电会减少电网购电，但这里电费按整栋用电量计，不是扣除光伏和储能后的结算账单。'
    text += '未结束的小时仅供时段比较，不计入截至当前的累计电费。'
    if re.search(r'每小时|逐时|各时段|明细', question):
        text += '\n'+'\n'.join(f'{slot(r)} {r["period_name"]}，{r["price_cny_per_kwh"]:.2f} 元/kWh，负荷 {r["building_load_kw"]:,.1f} kW，电网 {r["grid_kw"]:,.1f} kW，储能{r["storage_action_name"]} {abs(r["storage_kw"]):,.1f} kW。' for r in rows)
    evidence = {'source': source, 'tariff_source': 'configs/agent_tools.json', 'date': date,
                'as_of': clock, 'scope_name': f'{start:02d}:00–{end:02d}:00', 'hours': rows,
                'billing_basis_name': '整栋小时用电量乘已配置单价，不是净购电结算账单',
                'highest_price_hours': [r['hour'] for r in rows if r['price_cny_per_kwh'] == highest],
                'lowest_price_hours': [r['hour'] for r in rows if r['price_cny_per_kwh'] == lowest],
                'highest_cost_hour': costly['hour'], 'lowest_cost_hour': cheapest['hour']}
    return text, evidence
