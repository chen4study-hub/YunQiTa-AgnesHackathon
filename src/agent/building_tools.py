"""Read-only operational data tools; public answers retain exact source provenance."""
import hashlib
import json
import re
from datetime import date,datetime,timedelta
from pathlib import Path
from jsonschema import validate

ROOT=Path(__file__).resolve().parents[2]
SCENARIOS=('normal','peak','abstain')
NO_DATA='这个数现在查不到。'
NAMES={'tariff_periods':('分时电价与用电','按时段查询逐小时已配置电价、整栋负荷、电网功率、储能动作及小时电费；区分单价与小时电费高低，不是累计电费或结算账单'),
 'energy_totals':('用电与电费','查询今日截至时刻、指定日期或最近几天的累计用电和电费'),
 'end_use':('分项用电','查询当前空调、照明、插座、电梯功率与占比，或累计分项电量'),
 'alerts_orders':('告警与工单','查询截至当前时刻的告警和工单状态，不把未来告警算作已发生'),
 'elevator_state':('电梯运行记录','查询电梯当前位置或起终楼层、载客数、载重百分比和运行记录，不证明设备健康'),
 'floor_state':('楼层环境与负荷','查询指定楼层的负荷、人数、温度、CO₂、新风、风机和照明'),
 'storage_history':('储能剩余电量与充放电记录','查询电池当前剩余电量（SOC 百分比）、当前功率和截至时刻的充放电电量。支持问剩多少电、还能用多少电、充放电记录；不是缺失数据。'),
 'pv_generation':('光伏发电','查询当前光伏功率和截至时刻的发电量'),
 'building_state':('楼宇运行概览','查询当前负荷、室内环境、人数、湿度、PM2.5及空调设定')}
PARAMS={'type':'object','properties':{'date':{'type':'string','format':'date'},'days':{'type':'integer','minimum':1,'maximum':31},
 'floor':{'type':'integer','minimum':1,'maximum':40},'elevator':{'type':'string','pattern':'^[LH][1-9][0-9]?$'},
 'scope':{'type':'string','enum':['current','cumulative']}},'additionalProperties':False}
TARIFF_PARAMS={'type':'object','properties':{'start_hour':{'type':'integer','minimum':0,'maximum':23},
 'end_hour':{'type':'integer','minimum':1,'maximum':24}},'additionalProperties':False}
CATALOG=[{'name':k,'display_name':v[0],'description':v[1],'parameters':TARIFF_PARAMS if k=='tariff_periods' else PARAMS} for k,v in NAMES.items()]


def is_building_question(q):
    return bool(re.search(r'楼|云栖塔|办公|客流|空气|开销|运维|用电|能耗|电费|负荷|储能|电池|光伏|空调|照明|插座|电梯|告警|报警|工单|人数|人员|多少人|有人|电池|业主|温度|湿度|天气|CO[₂2]|新风|风机|PM2|调度|设定|表计|电量|充放电|充电|放电',q,re.I))


def fast_choices(q):
    from .tariff_periods import period_question
    if period_question(q):return [{'tool':'tariff_periods','parameters':{}}]
    choices=[];params={}
    m=re.search(r'(\d{4}-\d{2}-\d{2})',q)
    if m:params['date']=m[1]
    else:
        m=re.search(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日',q)
        if m:params['date']=f'{int(m[1]):04d}-{int(m[2]):02d}-{int(m[3]):02d}'
    m=re.search(r'(?:近|最近|过去)(\d+)天',q)
    if m:params['days']=min(31,int(m[1]))
    elif any(w in q for w in ('近一周','最近一周')):params['days']=7
    elif any(w in q for w in ('这几天','近几天','最近几天')):params['days']=3
    elif any(w in q for w in ('最近','近期')):params['days']=3
    if any(w in q for w in ('昨天','昨日')):params['relative_day']=-1
    elif '前天' in q:params['relative_day']=-2
    def add(tool,p=None):
        if tool not in [c['tool'] for c in choices]:choices.append({'tool':tool,'parameters':p if p is not None else dict(params)})
    m=re.search(r'(\d+)\s*(?:层|楼)',q)
    if m:add('floor_state',{'floor':int(m[1])})
    if any(w in q for w in ('告警','报警','工单','故障')):add('alerts_orders')
    if '电梯' in q and not any(w in q for w in ('用电','耗电','占比')):
        m=re.search(r'\bL\d+\b',q,re.I);add('elevator_state',{'elevator':m[0].upper()} if m else {})
    if any(w in q for w in ('充放电记录','充电记录','放电记录','今天充电','今天放电','储能记录','储能充','储能放')):add('storage_history')
    if '光伏' in q and any(w in q for w in ('发电量','发了','多少电','电量','累计')):add('pv_generation')
    if any(w in q for w in ('占比','占多少','分项','照明用电','插座用电','空调用电','电梯用电')):
        add('end_use',{'scope':'cumulative' if any(w in q for w in ('累计','今天','今日','昨日','昨天')) or params else 'current',**params})
    elif any(w in q for w in ('总能耗','开销','用了多少电','用电量','总用电','电费多少','多少电费','累计用电','耗了多少','耗电量','用电情况','用电和电费','电费和用电','电费','今天能耗','今日能耗','用电趋势','能耗趋势','多少度电')) and not any(w in q for w in ('改','省','方案')):add('energy_totals')
    if not choices and any(w in q for w in ('楼宇概况','运行概览','室内湿度','室内温度','室内空气','客流','空气品质','空气闷','总人数','有多少人','室内CO₂','室内CO2','楼里多少人','楼内人数','PM2.5')):add('building_state')
    return choices


def load(scenario,kind='ops'):
    if scenario not in SCENARIOS:raise ValueError('invalid scenario')
    p=ROOT/'exports/replay'/f'{scenario}.{kind}.json'
    return json.loads(p.read_text(encoding='utf-8')),p.relative_to(ROOT).as_posix()


def num(v,unit=''):
    if v is None:return '未提供'
    s=f'{float(v):,.1f}'.rstrip('0').rstrip('.')
    return s+('%' if unit=='%' else ' '+unit if unit else '')


def execute_choice(choice,question,data,row,display_date=None,display_time=None):
    tool=choice['tool'];p=dict(choice.get('parameters') or {})
    if tool not in NAMES:raise ValueError('unknown tool')
    relative=p.pop('relative_day',None);validate(p,TARIFF_PARAMS if tool=='tariff_periods' else PARAMS)
    if relative not in (None,-1,-2):raise ValueError('invalid relative day')
    today=date.fromisoformat(display_date) if display_date else datetime.now().astimezone().date()
    if relative is not None:p['date']=(today+timedelta(days=relative)).isoformat()
    target=date.fromisoformat(p.get('date',today.isoformat()))
    if target>today:raise ValueError('future operational date')
    clock=display_time or datetime.fromisoformat(row['t']).strftime('%H:%M')
    hour,minute=map(int,clock.split(':'))
    if not (0<=hour<24 and 0<=minute<60):raise ValueError('invalid clock')
    asof=hour*3600000+minute*60000
    scenario=data['meta']['scenario'];ops,source=load(scenario)
    if target!=today and tool not in ('energy_totals','end_use'):raise ValueError('unsupported date')
    selected=max((h for h in ops['hours'] if h['offset_ms']<=asof),key=lambda h:h['offset_ms'])
    evidence={'source':source,'as_of':clock,'date':target.isoformat()};text=''
    if tool=='tariff_periods':
        from .tariff_periods import comparison
        text,evidence=comparison(question,ops,source,today.isoformat(),clock,p)
    elif tool in ('energy_totals','end_use'):
        calendar=json.loads((ROOT/'exports/replay/ops-calendar.json').read_text(encoding='utf-8'))
        mapping={d['date']:d['scenario'] for d in calendar['days']}
        days=p.get('days',1);entries=[]
        for i in range(days-1,-1,-1):
            day=target-timedelta(days=i)
            if day==today:d,path=ops,source
            elif day.isoformat() in mapping:d,path=load(mapping[day.isoformat()])
            else:continue
            # Current hour's energy describes the hour ending after its timestamp.
            # At 14:00 include completed hours 00..13 only, never the future full day.
            rows=[h for h in d['hours'] if day!=today or h['offset_ms']+3600000<=asof]
            energy={k:round(sum(h['energy']['hour_kwh'][k] for h in rows),1) for k in d['summary']['energy_kwh']}
            entries.append({'date':day.isoformat(),'source':path,'energy_kwh':energy,
                'cost_cny':round(sum(h['energy']['hour_cost_cny'] for h in rows),1),'complete':day!=today})
        evidence.update(days=entries,calendar_source='exports/replay/ops-calendar.json',coverage_complete=len(entries)==days)
        if len(entries)==days:
            if tool=='energy_totals':
                total=round(sum(e['energy_kwh']['actual_kwh'] for e in entries),1)
                cost=round(sum(e['cost_cny'] for e in entries),1)
                evidence.update(total_kwh=total,total_cost_cny=cost)
                scope=f'截至 {clock}' if target==today else '全天'
                prefix=f"最近 {days} 天（{'截至今天 '+clock if target==today else '截至 '+str(target.month)+' 月 '+str(target.day)+' 日全天'}）" if days>1 else ('今天'+scope if target==today else ('昨天全天' if target==today-timedelta(days=1) else f'{target.month} 月 {target.day} 日全天'))
                text=f'{prefix}，用电 {num(total,"kWh")}，电费 {num(cost,"元")}。'
            else:
                labels={'hvac_electric_estimate':'空调','lighting':'照明','plug':'插座','elevator':'电梯','other':'其他'}
                current=p.get('scope','current')=='current' and target==today
                values=selected['end_uses'] if current else {k:round(sum(e['energy_kwh'][k] for e in entries),1) for k in entries[0]['energy_kwh']}
                total=selected['actual_kw'] if current else sum(e['energy_kwh']['actual_kwh'] for e in entries)
                unit='kW' if current else 'kWh';suffix='_kw' if current else '_kwh';parts=[]
                evidence.update(values=values,total=total,unit=unit,shares={})
                for key,label in labels.items():
                    if any(w in question for w in labels.values()) and label not in question:continue
                    value=values.get(key+suffix)
                    if value is None:continue
                    share=round(value/total*100,1) if total else 0
                    evidence['shares'][key]=share;parts.append(f'{label} {num(value,unit)}，占 {num(share,"%")}')
                text=('当前' if current else (f"最近 {days} 天（{'截至今天 '+clock if target==today else '截至 '+str(target.month)+' 月 '+str(target.day)+' 日全天'}）" if days>1 else f'{target.month} 月 {target.day} 日'+(f'截至 {clock}' if target==today else '全天'))+'累计分项电量：')+'；'.join(parts)+'。'
    elif tool=='alerts_orders':
        fields=['alerts','work_orders'] if '工单' in question and any(w in question for w in ('告警','报警')) else ['work_orders'] if '工单' in question else ['alerts']
        groups={}
        for field in fields:
            entries=[]
            for record in ops[field]:
                if record['offset_ms']>asof:continue
                record=dict(record)
                if record.get('resolved_offset_ms') is not None and record['resolved_offset_ms']>asof:record['status']='待核查'
                entries.append(record)
            groups[field]=entries
            label='工单' if field=='work_orders' else '告警'
            text+=f'截至 {clock}，共有 {len(entries)} 条{label}记录。'
            for e in entries[:10]:
                mins=e['offset_ms']//60000;stamp=f'{mins//60:02d}:{mins%60:02d}'
                asset=e.get('asset_id','');floor=re.fullmatch(r'floor-(\d+)-(east|west|north|south|northeast|northwest|southeast|southwest)',asset)
                location=f'{floor[1]} 层'+{'east':'东区','west':'西区','north':'北区','south':'南区','northeast':'东北区','northwest':'西北区','southeast':'东南区','southwest':'西南区'}[floor[2]] if floor else {'storage':'储能站','pv':'光伏电站','grid':'配电站','hvac':'空调系统'}.get(asset,'设备位置未提供')
                text+=f'{stamp} {location}，{e["system"]}：{e["content"]}，{e["status"]}。'
        entries=[e for group in groups.values() for e in group]
        evidence.update(groups=groups,records=entries,count=len(entries))
    elif tool=='elevator_state':
        states=[]
        for lift in ops['elevators']:
            if p.get('elevator') and lift['id']!=p['elevator']:continue
            trips=[t for t in lift['trips'] if t['depart_ms']<=asof]
            last=trips[-1] if trips else None
            state={'id':lift['id'],'capacity_people':lift['capacity_people']}
            if last and asof<last['arrive_ms']:
                state.update(status='运行中',from_floor=last['from_floor'],to_floor=last['to_floor'],passengers=last['passengers'],load_pct=last['load_pct'])
                line=f'{lift["id"]} 从 {last["from_floor"]} 层驶向 {last["to_floor"]} 层，载客 {last["passengers"]} 人，载重 {num(last["load_pct"],"%")}。'
            else:
                floor=last['to_floor'] if last else lift['initial_floor']
                state.update(status='停靠',floor=floor,passengers=last['passengers'] if last and asof<last['arrive_ms']+last['dwell_ms'] else 0)
                state['load_pct']=last['load_pct'] if state['passengers'] else 0
                line=f'{lift["id"]} 停靠 {floor} 层，载客 {state["passengers"]} 人，载重 {num(state["load_pct"],"%")}。'
            states.append(state);text+=line
        evidence['states']=states
        if states and any(w in question for w in ('正常','故障','健康')):text+='这些是运行记录，当前没有设备故障诊断数据。'
    elif tool=='floor_state':
        floors,path=load(scenario,'ops-floors');evidence['source']=path
        # Fixed allowlist file; hash-bind when Ops has published a binding.
        expected=ops['meta'].get('floors_sha256')
        if expected and hashlib.sha256((ROOT/path).read_bytes()).hexdigest()!=expected:raise ValueError('floor evidence mismatch')
        h=max((h for h in floors['hours'] if h['offset_ms']<=asof),key=lambda h:h['offset_ms'])
        f=next((f for f in h['floors'] if f['floor']==p.get('floor')),None)
        if not p.get('floor'):
            rows=h['floors'];people=sum(f['occupancy_people'] for f in rows)
            load_kw=round(sum(f['floor_actual_kw'] for f in rows),1)
            temps=[f['mean_temp_c'] for f in rows];co2=[f['co2_ppm'] for f in rows]
            evidence.update(floors=rows,people_total=people,load_total_kw=load_kw,temp_range=[min(temps),max(temps)],co2_range=[min(co2),max(co2)])
            text=f'当前楼层记录汇总：人数 {num(people)} 人，负荷 {num(load_kw,"kW")}，温度范围 {num(min(temps),"°C")} 至 {num(max(temps),"°C")}，CO₂ 范围 {num(min(co2),"ppm")} 至 {num(max(co2),"ppm")}。可指定楼层查询详情。'
        elif f:
            evidence['floor']=f
            text=f'{f["floor"]} 层当前负荷 {num(f["floor_actual_kw"],"kW")}，人数 {num(f["occupancy_people"])} 人，温度 {num(f["mean_temp_c"],"°C")}，CO₂ {num(f["co2_ppm"],"ppm")}，新风量 {num(f["fresh_air_m3_h"],"m³/h")}，风机 {num(f["fan_pct"],"%")}，照明 {num(f["lighting_pct"],"%")}。'
    elif tool in ('storage_history','pv_generation'):
        rows=[h for h in ops['hours'] if h['offset_ms']+3600000<=asof]
        if tool=='storage_history':
            charge=round(sum(max(0,-h['storage']['power_kw']) for h in rows),1)
            discharge=round(sum(max(0,h['storage']['power_kw']) for h in rows),1)
            records=[{'offset_ms':h['offset_ms'],**h['storage']} for h in rows]
            evidence.update(storage=selected['storage'],charge_kwh=charge,discharge_kwh=discharge,records=records)
            text=f'当前储能电量 {num(selected["storage"]["soc"]*100,"%")}，功率 {num(selected["storage"]["power_kw"],"kW")}（正值放电，负值充电）。截至 {clock}，充电 {num(charge,"kWh")}，放电 {num(discharge,"kWh")}。'
            if not re.search(r'记录|历史|累计|截至|今天|充电|放电',question):
                text=f'当前储能电量 {num(selected["storage"]["soc"]*100,"%")}。'
                if '功率' in question:text+=f'储能功率 {num(selected["storage"]["power_kw"],"kW")}。'
            if re.search(r'累计|一共|总共|充电量|放电量|充了.*电|放了.*电|今天|今日',question) and not re.search(r'记录|历史|功率|SOC|剩余|现在电量|当前电量',question,re.I):
                charge_only=bool(re.search(r'充电|充了',question))
                discharge_only=bool(re.search(r'放电|放了',question))
                parts=[]
                if charge_only or not discharge_only:parts.append(f'充电 {num(charge,"kWh")}')
                if discharge_only or not charge_only:parts.append(f'放电 {num(discharge,"kWh")}')
                text=f'今天截至 {clock}，'+ '，'.join(parts)+'。'
            if '记录' in question:
                for h in records[-6:]:text+=f'{h["offset_ms"]//3600000:02d}:00，功率 {num(h["power_kw"],"kW")}。'
        else:
            generation=round(sum(h['pv']['power_kw'] for h in rows),1)
            evidence.update(pv=selected['pv'],generation_kwh=generation)
            text=f'当前光伏功率 {num(selected["pv"]["power_kw"],"kW")}，截至 {clock} 发电量 {num(generation,"kWh")}。'
    elif tool=='building_state':
        evidence.update(environment=selected['environment'],actual_kw=selected['actual_kw'],setpoint=selected['hvac_setpoint_c'])
        e=selected['environment']
        text=f'当前负荷 {num(selected["actual_kw"],"kW")}，人数 {num(e["people"])} 人，室内温度 {num(e["indoor_temp_c"],"°C")}，湿度 {num(e["relative_humidity_pct"],"%")}，CO₂ {num(e["co2_ppm"],"ppm")}，PM2.5 {num(e["pm25_ug_m3"],"μg/m³")}，空调设定 {num(selected["hvac_setpoint_c"],"°C")}。'

    return {'answer':text or NO_DATA,'known':bool(text),'reason':'answered',
        'needs_human':False,'grounded':True,'selected_tool':tool,'tool_trace':[{'tool':tool,'result':evidence}],
        'answer_source':'deterministic_tools','llm_called':False,'llm_mode':'rule','explanation_source':'template'}
