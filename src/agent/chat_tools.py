"""Read-only grounded chat tools. Origin-local dates and question-scoped handoff."""
import copy
import re
import time
from datetime import datetime,timedelta
from src.agent.tools import simulate_schedule,tool_config,get_forecast,replay_soc
from src.agent.orchestrator import rounded_tools,check_grounding
from src.agent.display_text import public_text,display_evidence,relative_time,restore_host_clocks

TOOLS=['get_time','get_weather','selection_reason','handoff_reason','execution_receipt','current_state','current_energy','forecast_peak','hvac_compare','unknown']


def local_current_weather(question):
    """Narrow whole-question grammar: unknown place/topic modifiers go to catalogue."""
    q=re.sub(r'[\s，,。.!！?？：:]', '', question)
    return bool(re.fullmatch(
        r'(?:请问|请告诉我|告诉我)?(?:云栖塔|本楼|本栋|这里|楼外)?'
        r'(?:的)?(?:现在|当前|今天|今日)?(?:的)?(?:室外|楼外)?'
        r'(?:天气|气温|室外温度|温湿度|湿度)(?:和湿度|及湿度)?'
        r'(?:怎么样|如何|怎样|多少|是多少|几度|多高)?(?:呢|吗)?', q))


def local_weather_scope(question):
    if local_current_weather(question):return True
    q=re.sub(r'[\s，,。.!！?？：:]', '',question)
    return bool(re.fullmatch(r'(?:本楼|云栖塔)?(?:的)?(?:未来几小时|接下来几小时|明天|次日)(?:的)?天气(?:怎么样|如何)?',q))


def relative_hvac_delta(question):
    if '空调' not in question:return None
    m=re.search(r'(调低|降低|下调|调高|升高|上调|降|升)(?:温度|温)?\s*([一二三两]|\d+(?:\.\d+)?)\s*(?:度|℃|°C)',question)
    if not m:return None
    amount=float({'一':'1','二':'2','两':'2','三':'3'}.get(m[2],m[2]))
    return (-1 if m[1] in ('调低','降低','下调','降') else 1)*amount


def absolute_hvac_target(question):
    if '空调' not in question:return None
    m=re.search(r'(?:调到|调至|调为|改到|改为|设为|设置为|设定为|调整到|调整至|改)\s*(\d+(?:\.\d+)?)\s*(?:度|℃|°C)',question)
    return float(m[1]) if m else None


def hvac_change(question,current_setpoint):
    # Both input forms resolve through the same actual-origin delta path.
    target=absolute_hvac_target(question)
    delta=round(target-current_setpoint,1) if target is not None else relative_hvac_delta(question)
    return (round(current_setpoint+delta,1),delta) if delta is not None else (None,None)


def local_current_load(question):
    q=re.sub(r'[\s，,。.!！?？：:]', '',question)
    return bool(re.fullmatch(r'(?:请问|请告诉我|告诉我)?(?:本楼|楼宇|云栖塔)?(?:的)?'
        r'(?:现在|当前|此刻)(?:的)?(?:总负荷|总用电功率|楼宇用电功率|总功率|负荷)'
        r'(?:是|为)?(?:多少|是多少|怎么样|如何)(?:呢|吗)?',q))


def local_current_energy(question):
    """Whole-question current readings, not energy-industry news or definitions."""
    q=re.sub(r'[\s，,。.!！?？：:]', '', question)
    return bool(re.fullmatch(
        r'(?:请问|请告诉我|告诉我)?(?:云栖塔|本楼|本栋)?(?:的)?'
        r'(?:(?:当前|现在)(?:的)?能源(?:状况|情况|功率)?(?:怎么样|如何|怎样|多少|是多少)?'
        r'|(?:现在|当前)(?:的)?光伏(?:现在|当前)?(?:发电功率|功率|发多少电|发电多少|发多少|多少)'
        r'|光伏(?:现在|当前)(?:发电功率|功率|发多少电|发电多少|发多少|多少))'
        r'(?:呢|吗)?', q))


def intent(question):
    if local_current_energy(question):return 'current_energy',None
    if relative_hvac_delta(question) is not None:return 'hvac_compare',None
    target=absolute_hvac_target(question)
    if target is not None:return 'hvac_compare',target
    if not any(w in question for w in ('峰值','负荷','高峰','最高','最大')) and any(w in question for w in ('几点','时间','日期','几月','几号','哪天','星期')):return 'get_time',None
    if local_current_weather(question):return 'get_weather',None
    if any(w in question for w in ('转人工','人工原因','拒绝原因','接管')):return 'handoff_reason',None
    if any(w in question for w in ('回执','执行记录')):return 'execution_receipt',None
    if any(w in question for w in ('光伏','电网','储能功率','充电功率','放电功率','能源功率')):return 'current_energy',None
    if re.search(r'(?:储能|电池).*?(?:剩|余量|还能用)',question) and not re.search(r'知识|原理|意思|是什么',question):return 'current_state',None
    if any(w in question.lower() for w in ('soc','电量','气温','温度','设定','储能状态')) and not any(w in question for w in ('改','省','电费','费用')):return 'current_state',None
    if any(w in question for w in ('为什么','理由','依据')) and '调度' in question:return 'selection_reason',None
    if (any(w in question for w in ('峰值','最高负荷','最大负荷')) or re.search(r'负荷.*(?:最高|最大)|(?:最高|最大).*负荷|哪个小时.*(?:最高|最大)',question)) and not any(w in question for w in ('省','电费','空调')):return 'forecast_peak',None
    if '空调' in question and any(w in question for w in ('改','省','电费','费用')):
        m=re.search(r'(\d+(?:\.\d+)?)\s*(?:度|℃|°C)',question)
        return 'hvac_compare',float(m.group(1)) if m else None
    return 'unknown',None


def local_label(origin,target):
    a=datetime.fromisoformat(origin);b=datetime.fromisoformat(target).astimezone(a.tzinfo)
    days=(b.date()-a.date()).days
    return ('今天' if days==0 else '次日' if days==1 else f'{b.month}月{b.day}日'),b


def peak_scope(question):
    if '24小时' in question or '24 小时' in question:return 'future_24h'
    if any(w in question for w in ('次日','明天','翌日')):return 'next_day'
    if any(w in question for w in ('今天','今日','当天')):return 'today_remaining'
    return 'future_24h'


def future_forecast(data,row,scope='future_24h'):
    origin=datetime.fromisoformat(row['t'])
    predictions=sorted((p for p in row['forecast_24h'] if datetime.fromisoformat(p['t'])>origin),key=lambda p:datetime.fromisoformat(p['t']))
    if scope!='future_24h':
        date=origin.date()+timedelta(days=1 if scope=='next_day' else 0)
        predictions=[p for p in predictions if datetime.fromisoformat(p['t']).astimezone(origin.tzinfo).date()==date]
    if not predictions:return dict(building_id=data['meta']['building_id'],model_version=data['meta']['multi_horizon_model_version'],predictions=[])
    def fetch(building,start,end):
        p=next(p for p in predictions if datetime.fromisoformat(p['t'])==start)
        return dict(model_version=data['meta']['multi_horizon_model_version'],predictions=[dict(timestamp=p['t'],point=p['point_kw'],lower=p['lower_kw'],upper=p['upper_kw'],
            confidence=p['confidence'],abstain=p['abstain'],abstain_reason=p.get('abstain_reason') or ('forecast_gate_refused' if p['abstain'] else None),risk_score=p['risk_score'],risk_threshold=p['risk_threshold'])])
    start=origin+timedelta(hours=1) if scope=='future_24h' else datetime.fromisoformat(predictions[0]['t'])
    end=origin+timedelta(hours=25) if scope=='future_24h' else datetime.fromisoformat(predictions[-1]['t'])+timedelta(hours=1)
    return get_forecast(fetch,data['meta']['building_id'],start,end)


def future_context(row):
    tariff=tool_config()['tariff'];hours=[];origin=datetime.fromisoformat(row['t'])
    for p in row['forecast_24h']:
        hour=datetime.fromisoformat(p['t']).astimezone(origin.tzinfo).hour;period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
        hours.append(dict(timestamp=p['t'],outdoor_temp_c=row['outdoor_temp_c'],pv_kw=0.,storage_soc=replay_soc(row),
            price_per_kwh=tariff[period],tariff_period=period,source='origin temperature persistence, zero PV/battery, configured tariff'))
    return {'hours':hours}


def comparison_scope(row,forecast):
    excluded=[]
    for p in forecast['predictions']:
        if not p['abstain']:continue
        label,t=local_label(row['t'],p['timestamp'])
        reason='预测可靠性不足'
        if p.get('abstain_reason')=='interval_too_wide':reason='负荷波动范围较大'
        elif p.get('risk_score') is not None and p.get('risk_threshold') is not None and p['risk_score']>p['risk_threshold']:reason='预测变化较大'
        excluded.append(dict(timestamp=p['timestamp'],day_label=label,year=t.year,month=t.month,day=t.day,hour=t.hour,minute=t.minute,
            reason=reason,abstain_reason=p.get('abstain_reason'),confidence=p.get('confidence'),risk_score=p.get('risk_score'),risk_threshold=p.get('risk_threshold')))
    return dict(total_hours=len(forecast['predictions']),accepted_hours=sum(not p['abstain'] for p in forecast['predictions']),excluded_hours=len(excluded),excluded=excluded,
        scope='accepted forecast hours only; not whole-day savings')


def question_fields(tool,question):
    """Ask only for the values named by the operator; broad queries retain all."""
    groups={'current_state':{'soc_percent':('soc','电量','储能','电池'),'hvac_setpoint_c':('空调','设定','温控'),'outdoor_temp_c':('室外','气温')},
        'current_energy':{'pv_kw':('光伏',),'grid_kw':('电网',),'battery_kw':('储能','充电','放电')}}
    group=groups.get(tool,{})
    chosen=[k for k,words in group.items() if any(w in question.lower() for w in words)]
    return chosen or list(group)


def comparison_scope_text(scope):
    text=f"本次只覆盖可自动调度的 {scope['accepted_hours']} 个小时，另有 {scope['excluded_hours']} 个小时未计入，不按整天计算。"
    if scope['excluded']:
        # Validate full day-qualified timestamps FIRST; render_public_fields
        # compacts only after grounding. Early compaction loses next-day labels.
        listing='；'.join(f"{e['day_label']} {e['hour']:02d}:{e['minute']:02d}（{e['reason']}）" for e in scope['excluded'])
        text+='未计入时段：'+listing+'；请值班人员核对这些时段的表计和设备记录。'
    return text


def execute(tool,question,data,row,setpoint=None,display_date=None,display_time=None):
    from src.data.replay_payload import ensure_hour
    row=ensure_hour(data,row)
    trace=[];known=True;needs=bool(row['abstain'] or row['agent']['status']=='handoff');required=[];fields=None
    def call(name,args,fn,summary):
        yield dict(type='tool_start',tool=name,args=args)
        start=time.monotonic();result=fn();trace.append(dict(tool=name,result=result))
        yield dict(type='tool_end',tool=name,ms=round((time.monotonic()-start)*1000,1),summary=summary(result))
        return result
    args={'origin':row['t']}
    if tool=='get_time':
        now=datetime.now().astimezone();display_date=display_date or now.date().isoformat()
        clock=display_time or now.strftime('%H:%M');hour,minute=map(int,clock.split(':'))
        d=datetime.fromisoformat(display_date)
        r=yield from call(tool,args,lambda:dict(timestamp=row['t'],hour=hour,minute=minute,display_date=display_date,display_time=clock,month=d.month if d else None,day=d.day if d else None),lambda r:'已读取显示时钟。')
        needs=False;text='现在 '+clock+'。';required=[hour,minute]
        if any(w in question for w in ('日期','几月','几号','哪天','星期')):
            if display_date:
                d=datetime.fromisoformat(display_date);text=f'今天是 {d.month} 月 {d.day} 日。';required=[d.month,d.day]
            else:text='未提供显示日期，无法回答几号。';required=[]
            if any(w in question for w in ('几点','时间')):text+='现在 '+clock+'。';required+=[hour,minute]
    elif tool=='get_weather':
        future=any(w in question for w in ('未来','接下来','随后','几小时','后面','预报'))
        source_rows=row['forecast_24h'][:3] if future else [row]
        hours=[{'timestamp':r['t'],**r.get('weather',{'outdoor_temp_c':r.get('outdoor_temp_c'),'relative_humidity_pct':None,'basis':'missing humidity; temperature if available'})} for r in source_rows]
        for h in hours:
            value=h.get('relative_humidity_pct');h['humidity_percent']=int(round(value)) if value is not None else None
        r=yield from call(tool,args,lambda:dict(hours=hours,scope='future_hours' if future else 'current'),lambda r:'已读取未来逐小时室外温度及湿度。' if future else '已读取当前室外温度及湿度。')
        needs=False;text='';known=any(h.get('outdoor_temp_c') is not None for h in hours)
        for h in hours:
            text+=relative_time(h['timestamp'],row['t'])+'：' if future else '当前'
            text+=f"室外 {h['outdoor_temp_c']:.1f} °C" if h.get('outdoor_temp_c') is not None else '室外温度缺失'
            text+=f"，湿度 {h['humidity_percent']}%。" if h.get('relative_humidity_pct') is not None else '，湿度记录缺失。'
        # Origin-persistence/derived humidity provenance is disclosed on About, not prose.
        required=[round(v,1) for h in hours for v in [h.get('outdoor_temp_c'),h.get('humidity_percent')] if v is not None]
    elif tool=='selection_reason':
        r=yield from call(tool,args,lambda:copy.deepcopy(row['agent'].get('selection_reason')),lambda r:'已读取当前候选选择及电费、上界峰值依据。')
        if not r:known=False;text='不知道。当前选择依据记录缺失。'
        else:
            candidate=next((c for c in row['agent'].get('candidates',[]) if c['candidate_id']==r['selected_candidate_id']),{})
            r['horizon_hours']=len(candidate['plan']) if candidate.get('plan') else None
            r['estimated_savings']=candidate.get('simulation',{}).get('estimated_savings')
            from .chat_evidence import selection_reference
            text=selection_reference(r)
            if needs:text='今天当前小时未自动下发，已转人工。'+text
            selected=r.get('metrics',{}).get(r.get('selected_candidate_id'),{})
            required=[selected[k] for k in ['upper_grid_peak_kw','energy_cost_cny'] if selected.get(k) is not None]
            if r['estimated_savings'] is not None:required.append(round(r['estimated_savings'],1))
    elif tool=='handoff_reason':
        from .takeover import lookup,display_day,record_text
        hour=int((display_time or datetime.fromisoformat(row['t']).strftime('%H:%M')).split(':')[0])
        record=lookup(display_day(display_date),hour,data['meta']['building_id'])
        needs=bool(record or needs)
        r=yield from call(tool,args,lambda:dict(current_handoff=needs,active_takeover=record,
            abstain_reason=row.get('abstain_reason'),risk_score=row['risk_score'],risk_threshold=row['risk_threshold'],
            confidence=row['confidence'],work_orders=row['agent'].get('work_orders',[])),lambda r:'已读取接管记录及当前小时复核原因。')
        if record:
            text=record_text(record)
            from .display_text import numeric_tokens
            r['record_text_values']=[float(v) for v in numeric_tokens(text)]
        elif not needs:text='当前没有人工接管记录，也没有转人工；本小时可自动执行。'
        else:
            labels={'routing_risk_above_threshold':'预测变化较大','risk_score_above_threshold':'预测变化较大','interval_too_wide':'负荷波动范围较大'}
            reason=labels.get(r['abstain_reason'],'预测可靠性不足')
            text=f"当前没有已提交的人工接管记录；本小时因{reason}交值班人员处理，核对表计和设备记录后再决定如何运行。"
    elif tool=='execution_receipt':
        r=yield from call(tool,args,lambda:copy.deepcopy(row['agent'].get('receipt')),lambda r:'已读取 BA/EMS 下发日志回执。')
        if r is None:known=False;text='不知道。当前小时缺少执行回执。'
        else:
            text=f"今天当前小时回执确认 {r['count']} 条指令，耗时 {round(r['elapsed_ms'],1):.1f} 毫秒。"
            text+='这是 BA/EMS 下发日志回执。'
            if r.get('device_connected'):text+='记录显示设备已连接。'
            required=[r['count'],round(r['elapsed_ms'],1)]
    elif tool=='current_energy':
        r=yield from call(tool,args,lambda:dict(pv_kw=row.get('pv',{}).get('power_kw'),
            grid_kw=row.get('grid_kw'),battery_kw=row.get('storage',{}).get('power_kw')),
            lambda r:'已读取当前光伏、电网与储能功率。')
        needs=False;known=any(v is not None for v in r.values());parts=[]
        fields=question_fields(tool,question)
        for key,label in [('pv_kw','光伏功率'),('grid_kw','电网功率'),('battery_kw','储能功率')]:
            if key not in fields:continue
            value=r[key];parts.append(f"{label} {value:.1f} kW" if value is not None else label+'记录缺失')
        text='当前'+ '，'.join(parts)+'。'
        if 'battery_kw' in fields and r['battery_kw'] is not None:text+='储能正值为放电，负值为充电。'
        required=[round(r[k],1) for k in fields if r[k] is not None]
        known=any(r[k] is not None for k in fields)
    elif tool=='current_state':
        r=yield from call(tool,args,lambda:dict(soc=replay_soc(row),soc_percent=round(replay_soc(row)*100,1),
            soc_source='replay.storage.soc',soc_basis='current exported snapshot; derived from exported executed commands',
            outdoor_temp_c=row.get('outdoor_temp_c'),hvac_setpoint_c=row['agent']['hvac_setpoint_c']),lambda r:'已读取当前储能电量、气温及温控设定。')
        fields=question_fields(tool,question);parts=[];needs=False
        labels={'soc_percent':('储能电量','%'),'hvac_setpoint_c':('空调设定','°C'),'outdoor_temp_c':('室外气温','°C')}
        for k in fields:
            label,unit=labels[k];value=r[k]
            parts.append(f"{label} {value:.1f}{'' if unit=='%' else ' '}{unit}。" if value is not None else label+'记录缺失。')
        text='当前'+''.join(parts);required=[round(r[k],1) for k in fields if r[k] is not None]
    elif tool in ('forecast_peak','hvac_compare'):
        scope=peak_scope(question) if tool=='forecast_peak' else 'future_24h'
        forecast=yield from call('get_forecast',{**args,'scope':scope},lambda:future_forecast(data,row,scope),lambda r:'已读取指定当地日期范围内、起报后的逐步预测及门控。')
        if tool=='forecast_peak' and not forecast['predictions']:
            known=False;needs=False;text='这一天没有后续可用的负荷预测。'
        elif tool=='forecast_peak':
            def peak_value():
                p=max(forecast['predictions'],key=lambda p:p['point']);label,t=local_label(row['t'],p['timestamp'])
                return dict(day_label=label,scope=scope,prediction_hours=len(forecast['predictions']),year=t.year,month=t.month,day=t.day,hour=t.hour,minute=t.minute,peak_kw=round(p['point'],1),abstain=p['abstain'])
            r=yield from call(tool,args,peak_value,lambda r:'已找到预测峰值及其当地时刻。')
            prefix='今天剩余预测小时内' if scope=='today_remaining' else '本次预测中' if scope=='next_day' else '未来预测'
            needs=r['abstain'];text=f"{prefix}最高负荷约 {r['peak_kw']:.1f} kW，出现在{r['day_label']} {r['hour']:02d}:{r['minute']:02d}。"
            if needs:text+='这个时段预测把握不大，暂不自动执行。'
            required=[r['peak_kw'],r['hour']]
        else:
            resolved,delta=hvac_change(question,float(row['agent']['hvac_setpoint_c']))
            if resolved is not None:setpoint=resolved
            elif setpoint is not None:delta=round(setpoint-float(row['agent']['hvac_setpoint_c']),1)
            if setpoint is None or not 24<=setpoint<=27:
                known=False;needs=False;text='改后设定超出允许范围；本次未调整设备。' if setpoint is not None else '不知道'
            else:
                context=yield from call('get_context_scenario',args,lambda:future_context(row),lambda r:'采用起点气温持久性、配置电价和零光伏储能比较。')
                scope_info=comparison_scope(row,forecast);needs=bool(scope_info['excluded_hours'])
                today=[p for p in forecast['predictions'] if local_label(row['t'],p['timestamp'])[0]=='今天']
                scope_info.update(today_accepted_hours=sum(not p['abstain'] for p in today),
                    today_prediction_hours=len(today),comparison_available=bool(scope_info['accepted_hours']))
                accepted={**forecast,'predictions':[p for p in forecast['predictions'] if not p['abstain']]}
                timestamps={datetime.fromisoformat(p['timestamp']) for p in accepted['predictions']}
                accepted_context={'hours':[h for h in context['hours'] if datetime.fromisoformat(h['timestamp']) in timestamps]}
                baseline=[dict(timestamp=p['timestamp'],hvac_setpoint_c=row['agent']['hvac_setpoint_c'],battery_kw=0.,action='hold') for p in accepted['predictions']]
                changed=[{**p,'hvac_setpoint_c':setpoint} for p in baseline]
                if baseline:
                    before=yield from call('simulate_schedule_before',args,lambda:simulate_schedule(baseline,accepted,{'initial_soc':replay_soc(row)},accepted_context),lambda r:'已核验可自动调度时段的改前电费；其余小时未计入。')
                    after=yield from call('simulate_schedule_after',{'origin':row['t'],'setpoint_c':setpoint},lambda:simulate_schedule(changed,accepted,{'initial_soc':replay_soc(row)},accepted_context),lambda r:'已核验相同时段的改后电费。')
                    before_cost=round(before['estimated_cost'],1);after_cost=round(after['estimated_cost'],1)
                    savings=round(before['estimated_cost']-after['estimated_cost'],1)
                    before_peak=round(before['estimated_peak_kw'],1);after_peak=round(after['estimated_peak_kw'],1)
                    peak_change=round(after['estimated_peak_kw']-before['estimated_peak_kw'],1)
                else:before_cost=after_cost=savings=before_peak=after_peak=peak_change=None
                r=yield from call('compare_costs',{},lambda:dict(before_setpoint_c=float(row['agent']['hvac_setpoint_c']),after_setpoint_c=setpoint,
                    setpoint_delta_c=delta,before_cost=before_cost,after_cost=after_cost,savings_cny=savings,extra_cost_cny=max(0.,-savings) if savings is not None else None,
                    before_peak_kw=before_peak,after_peak_kw=after_peak,peak_increase_kw=max(0.,peak_change) if peak_change is not None else None,
                    peak_reduction_kw=max(0.,-peak_change) if peak_change is not None else None,**scope_info),lambda r:'已核对计入和未计入的小时及电费差额。')
                scope_text=comparison_scope_text(r)
                if not baseline:
                    # Verified absence is a known tool result, not an unavailable
                    # number nor zero savings. No numeric LLM composition.
                    known=True;needs=True
                    text='今天剩下的时段没有可自动调度的小时，算不出电费差额；次日也没有可用于比较的自动调度小时，交值班人员处理。'
                else:
                    difference=f"预计可节省 {r['savings_cny']:.1f} 元" if r['savings_cny']>=0 else f"预计多花 {r['extra_cost_cny']:.1f} 元"
                    text=f"从 {r['before_setpoint_c']:.1f} 度改为 {setpoint:.1f} 度，计入时段电费从 {r['before_cost']:.1f} 元变为 {r['after_cost']:.1f} 元，{difference}；"+f"同一批时段电网峰值从 {before_peak:.1f} kW 变为 {after_peak:.1f} kW，"+(f"增加 {r['peak_increase_kw']:.1f} kW。" if peak_change>=0 else f"降低 {r['peak_reduction_kw']:.1f} kW。")+scope_text
                    required=[r['before_setpoint_c'],setpoint,r['before_cost'],r['after_cost'],r['savings_cny'] if r['savings_cny']>=0 else r['extra_cost_cny'],r['accepted_hours'],r['excluded_hours'],before_peak,after_peak,r['peak_increase_kw'] if peak_change>=0 else r['peak_reduction_kw']]
                    if not r['today_accepted_hours']:
                        text='今天剩下的时段没有可自动调度的小时，算不出今天的电费差额；以下为次日同一设定在可自动调度时段的预计值，不代表完整全天。'+text
    else:known=False;needs=False;text='不知道'
    text=text.replace('今天当前小时',relative_time(row['t'],row['t'])+' 当前小时')
    evidence=display_evidence(rounded_tools(trace),row['t'],row)
    # Clock evidence stays private; public tool_trace shape is unchanged.
    try:
        if tool!='get_time':text=public_text(text,row['t'],evidence)
    except ValueError:text='不知道';known=False
    if tool!='get_time' and not check_grounding(text,evidence):
        yield dict(type='step',text='正在查询相关数据…')
        text='不知道';known=False
    required_text=[]
    if tool=='selection_reason' and known:
        required_text=[{'rule_full':'全额调度','rule_conservative':'保守调度','rule_hold':'保持设定'}.get(r.get('selected_candidate_id'),'当前方案')]
    elif tool=='execution_receipt':required_text=['BA/EMS','日志回执']
    elif tool=='handoff_reason':
        if not needs:required_text=['没有转人工']
        elif r.get('active_takeover'):required_text=[r['active_takeover']['operator_id'],r['active_takeover']['reason'],'不再自动下发']
        else:required_text=['交值班人员处理']
    elif tool=='forecast_peak' and known:
        required_text=[r['day_label']] if r['day_label']=='次日' else []
        if r['scope']=='today_remaining':required_text+=['剩余']
        if r['abstain']:required_text+=['暂不自动执行']
        # The available prediction range is retained in the tool trace.
    elif tool=='hvac_compare' and known:
        required_text=(['可自动调度','未计入','只覆盖']+[e['reason'] for e in r['excluded']] if r['comparison_available'] else
            ['没有可自动调度','算不出电费差额','交值班人员处理'])
    return dict(answer=text,known=known,needs_human=needs,tool_trace=trace,grounded=True if tool=='get_time' else check_grounding(text,evidence),required_text=required_text,
        answer_source='deterministic_tools',llm_called=False,required_values=required,required_fields=fields,selected_tool=tool)
