"""Rule episodes aggregate assets and only use evidence available at onset."""
from .config import HOUR_MS

TEMP_DURATION_MS = 2*HOUR_MS
TEMP_MARGIN_C = .5
ZONE_LABELS = {'north':'北区','northeast':'东北区','west':'西区',
               'east':'东区','southwest':'西南区','south':'南区'}
RULES = [
 {'id':'co2-high','threshold':1000,'unit':'ppm','system':'新风','content':'CO₂ 超过 1000 ppm','checks':['检查新风量','核对区域人数']},
 {'id':'temp-high','threshold':27.5,'unit':'°C','system':'空调','content':'室温高于 27.5 °C，且高于同期设定温度 0.5 °C，已持续 2 小时','checks':['检查温度设定','核对风机和送风']},
 {'id':'pm25-high','threshold':35,'unit':'μg/m³','system':'环境','content':'PM2.5 超过 35 μg/m³','checks':['检查过滤器','核对室外空气质量']},
 {'id':'soc-low','threshold':.3,'unit':'fraction','system':'储能','content':'储能电量低于 30%','checks':['核对充电计划','检查储能电量记录']},
]


def temperature_candidates(row):
    # A planned 26..27 C setpoint alone is not a fault. Require a material
    # deviation from it, as well as the absolute comfort tolerance.
    threshold = max(27+TEMP_MARGIN_C, row['hvac_setpoint_c']+TEMP_MARGIN_C)
    return {(f['floor'],z['id']) for f in row['floors'] for z in f['zones']
            if z['temp_c'] > threshold}


def temperature_content(assets):
    floors = len({f for f,z in assets})
    zones = sorted({z for f,z in assets})
    names = '、'.join(ZONE_LABELS.get(z,z) for z in zones)
    return f'{names} {len(assets)} 个区域（涉及 {floors} 层）室温高于 27.5 °C 已持续 2 小时（且高于同期设定温度 0.5 °C）'


def events(source_date,hours):
    alerts, orders, open_events = [], [], {}
    started, previous = {}, None
    for row in hours:
        offset = row['offset_ms']
        if previous is not None and offset != previous+HOUR_MS:
            raise ValueError('hourly contiguous evidence required for alert duration')
        candidates = temperature_candidates(row)
        started = {asset:started.get(asset,offset) for asset in sorted(candidates)}
        qualified = {asset for asset,start in started.items() if offset-start >= TEMP_DURATION_MS}
        checks = [('co2-high','building',row['environment']['co2_ppm']>1000,None),
                  ('pm25-high','building',row['environment']['pm25_ug_m3']>35,None),
                  ('soc-low','storage',row['storage']['soc']<.3,None),
                  ('temp-high','building',bool(qualified) or ('temp-high' in open_events and bool(candidates)),
                   temperature_content(qualified) if qualified else None)]
        for rule_id,asset,active,content in checks:
            if active and rule_id not in open_events:
                rule = next(r for r in RULES if r['id']==rule_id)
                ident = f'OPS-{offset//HOUR_MS:02d}-{rule_id}-{asset}'
                content = content or rule['content']
                alert = {'id':ident,'rule_id':rule_id,'offset_ms':offset,
                         'level':'关注','system':rule['system'],'asset_id':asset,
                         'content':content,'suggested_checks':rule['checks'],
                         'resolved_offset_ms':None,'status':'待核查','work_order_id':ident+'-WO'}
                order = {'id':ident+'-WO','alert_id':ident,'offset_ms':offset,
                         'system':rule['system'],'content':content,
                         'suggested_checks':rule['checks'],'status':'待核查','resolved_offset_ms':None}
                alerts.append(alert)
                orders.append(order)
                open_events[rule_id] = (alert,order)
            elif not active and rule_id in open_events:
                for item in open_events.pop(rule_id):
                    item['resolved_offset_ms'] = offset
                    item['status'] = '已恢复'
        previous = offset
    return alerts,orders
