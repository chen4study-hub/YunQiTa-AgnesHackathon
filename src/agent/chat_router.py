"""Question routing: fast paths, multi-tool catalogue, building/public source boundary."""
from src.api.rate_limit import chat_llm_status
import time
import re
from datetime import datetime
from .building_tools import CATALOG,NAMES,NO_DATA,fast_choices,execute_choice
from .chat_tools import intent,TOOLS,local_current_weather,local_weather_scope

LEGACY_NAMES={'get_time':'时间与日期','get_weather':'天气查询','selection_reason':'调度理由','handoff_reason':'人工复核原因',
 'execution_receipt':'执行回执','current_state':'当前设备状态','current_energy':'当前能源功率','forecast_peak':'负荷峰值预测','hvac_compare':'空调电费比较'}
DESCRIPTIONS={'get_time':'当前时间和日期','get_weather':'仅云栖塔本楼当前室外温湿度和本楼未来逐时天气；其他城市天气、新闻或来源链接请选web_search','selection_reason':'为什么选用当前调度方案',
 'handoff_reason':'查询当前人工接管记录、接管人、人工配置值以及是否转人工和原因','execution_receipt':'BA/EMS下发日志回执','current_state':'查询电池剩余电量（SOC 百分比），也可查询空调设定；剩多少电属于已有数据',
 'current_energy':'当前光伏、电网、储能功率','forecast_peak':'今天剩余或明天可用小时的负荷峰值',
 'hvac_compare':'指定24至27度或相对当前设定升降温的电费和峰值比较，仅按可自动调度时段计算'}
FULL_CATALOG=CATALOG+[{'name':k,'display_name':v,'description':DESCRIPTIONS[k],
 'parameters':{'type':'object','properties':{'setpoint_c':{'type':'number','minimum':24,'maximum':27}},'additionalProperties':False}}
 for k,v in LEGACY_NAMES.items()]+[{'name':'web_search','display_name':'联网查询','description':'查询公开知识、新近事实和用户明确要求联网/搜索的资料，不代替本楼实际读数，必须附来源链接',
 'parameters':{'type':'object','properties':{},'additionalProperties':False}},{'name':'city_weather','display_name':'查询城市天气','description':'Open-Meteo免key查询其他城市当前及次日温度、降水、天气代码，不是本楼读数','parameters':{'type':'object','properties':{},'additionalProperties':False}},{'name':'general_chat','display_name':'知识与聊天',
 'description':'一般常识、基础知识、概念原理及闲聊，包含运维知识，不是本楼实际读数',
 'parameters':{'type':'object','properties':{},'additionalProperties':False}}]


def emit_result(result):
    from .chat_display import reading_text
    result={**result,'answer':reading_text(result['answer'])}
    # Never split a numeric reading across deltas: the outer presentation pass
    # formats each delta independently, so a fixed 48-char cut corrupts decimals.
    for part in re.split(r'(?<=[。！？!?\n])',result['answer']):
        if part:yield {'type':'answer_delta','text':part}
    yield {'type':'done','known':result['known'],'needs_human':result['needs_human'],'grounded':result['grounded'],
        'explanation_source':result.get('explanation_source','template'),'phase_timings':result.get('phase_timings',[]),
        'llm_reason':result.get('llm',{}).get('reason'),'reason':result['reason']}
    return result


def building_reading_question(question):
    """Concrete local readings stay local; definitions are not measurements."""
    from .chat_tools import local_current_energy
    if local_current_energy(question):return True
    subject=bool(re.search(r'楼|云栖塔|负荷|峰值|电费|费用|用电|能耗|储能|电池|光伏|空调|电量|SOC|充电|放电|调度',question,re.I))
    definition=bool(re.search(r'什么是|(?:是|指的?是)什么(?:意思|原理)?[？?。]*$|基础知识|知识点|常识|原理|科普|介绍|解释一下|讲解|区别',question))
    local=bool(re.search(r'本楼|这个楼|云栖塔|当前|现在|今天|明天|次日|未来|剩余|剩多少|还剩|多少|几点|什么时候|最大|最高',question))
    return subject and (local or not definition)


def no_local_information():
    return {'answer':'这个信息系统里没有。','known':False,'needs_human':False,'grounded':True,
        'reason':'no_data','tool_trace':[],'explanation_source':'template','answer_source':'deterministic_tools',
        'llm_called':False,'llm_mode':'rule','llm':{'mode':'rule','reason':'local_information_missing'},'phase_timings':[]}


def route_events(question,data,row,provider=None,display_date=None,display_time=None):
    from .chat_engine import legacy_events,bounded_events,ProgressClock,get_llm_status
    from .provider import OpenAICompatibleProvider
    import json
    # Identity/management records are absent; never ask a public model to guess.
    if re.search(r'业主|物业',question) and not re.search(r'什么是|基础知识|知识点|原理|科普|介绍|区别',question):
        return (yield from emit_result(no_local_information()))
    from .chat_tools import local_current_load
    if local_current_load(question):
        # One frozen operating snapshot; total building demand is not grid import.
        r=execute_choice({'tool':'building_state','parameters':{}},question,data,row,display_date,display_time)
        value=r['tool_trace'][0]['result'].get('actual_kw')
        if value is not None:r['answer']=f'当前楼宇总用电功率 {value:,.1f} kW。'
        return (yield from emit_result(r))
    local_reading=building_reading_question(question)
    # Remove a host-clock prefix before classifying the remaining weather scope.
    clock_prefix=re.match(r'^(?:请问)?(?:现在|当前|今天)?(?:几点|几号|日期|几月几号)(?:了|钟)?[，,、；;？?\s]*(?:现在|今天)?',question)
    if clock_prefix and local_current_weather(question[clock_prefix.end():]):
        return (yield from legacy_events(question,data,row,provider,display_date,display_time))
    # Relative temperature changes use the actual current building setpoint,
    # never a household percentage or an LLM-invented absolute setpoint.
    from .chat_tools import relative_hvac_delta,absolute_hvac_target
    if relative_hvac_delta(question) is not None or absolute_hvac_target(question) is not None:
        from .chat_engine import single_events
        return (yield from single_events(question,data,row,provider,display_date,display_time,
            selected_choice={'tool':'hvac_compare','parameters':{}}))
    # Positive request semantics, not a topic blacklist or an out-of-scope gate.
    weather_parts=[p for p in re.split(r'[，、；;]|以及|还有|和',question) if re.search(r'天气|气温|湿度|室外',p) and not re.search(r'室内|房间|楼层',p)]
    weather_catalog=bool(weather_parts) and not all(local_current_weather(p) for p in weather_parts)
    # Public lookup is a native tool in general_chat, not a topic pre-search.
    # Other-city weather must query public sources even if route LLM is slow.
    # This is a source boundary, not a theme/out-of-scope refusal.
    from .city_weather import city_name
    city=city_name(question)
    if city and re.search(r'天气|气温|温度|台风',question):
        from .general_chat import events
        return (yield from events(question,provider,web=True,weather_first=True,display_date=display_date))
    if weather_catalog and (city_name(question) or re.search(r'新闻|近期|最近|新近|最新|来源|链接',question)):
        from .general_chat import events
        return (yield from events(question,provider,web=True,display_date=display_date))
    # Outdoor advice first reads local weather; never sends users to another app.
    if re.search(r'(?:适合|要不要|能不能|可以).*?(?:散步|跑步|出去玩)|(?:散步|跑步).*?(?:建议|吗)',question):
        from .chat_tools import execute
        yield {'type':'step','text':'正在查看天气…'}
        g=execute('get_weather','天气怎么样',data,row,display_date=display_date,display_time=display_time)
        while True:
            try:yield next(g)
            except StopIteration as end:r=end.value;break
        h=r['tool_trace'][-1]['result']['hours'][0]
        temp=h.get('outdoor_temp_c')
        if temp is not None:
            advice='气温适合短时散步，穿着舒适并留意路面。' if 10<=temp<=28 else '气温偏凉，散步时注意保暖。' if temp<10 else '气温较高，散步注意补水，避免剧烈活动。'
            r['answer']+=advice+'当前只有温湿度记录，降雨、风力和空气质量还需留意现场情况。'
        else:r['answer']+='天气记录不足，暂时不能判断是否适合散步。'
        r.update(reason='answered',explanation_source='template',needs_human=False)
        return (yield from emit_result(r))
    conceptual=bool(re.search(r'什么是|是什么|基础知识|知识点|常识|原理|科普|介绍|解释一下|讲解|区别|笑话|故事|闲聊',question))
    if conceptual and not local_reading and not weather_catalog and not re.search(r'回执|执行记录|接管|为什么.*调度',question):
        from .general_chat import events
        return (yield from events(question,provider,display_date=display_date))
    from .chat_tools import local_current_energy
    if local_current_energy(question):
        return (yield from legacy_events(question,data,row,provider,display_date,display_time))
    choices=[];questions={}
    for part in re.split(r'[，、；;]|以及|还有|和',question):
        for c in fast_choices(part):
            key=json.dumps(c,sort_keys=True,ensure_ascii=False)
            if key not in questions:choices.append(c);questions[key]=part
    if not choices:choices=fast_choices(question)
    if weather_catalog:choices=[]
    # Concrete receipt/state tools retain priority over generic '是什么'.
    tool,_=intent(question)
    if not weather_catalog and not choices and tool!='unknown' and not any(w in question for w in ('室内','房间','楼层')):
        return (yield from legacy_events(question,data,row,provider,display_date,display_time))
    if choices:
        for part in re.split(r'[，、；;]|以及|还有|和',question):
            name,temp=intent(part)
            if name!='unknown' and not fast_choices(part) and name not in [c['tool'] for c in choices]:
                choices.append({'tool':name,'parameters':{'setpoint_c':temp} if temp is not None else {}})
    progress=ProgressClock()
    route_failed=False
    public_weather=weather_catalog and not local_weather_scope(question)
    catalog=[c for c in FULL_CATALOG if not (public_weather and c['name']=='get_weather')]
    if not choices and chat_llm_status(provider, get_llm_status)['mode']=='real':
        provider=provider or OpenAICompatibleProvider()
        response=yield from bounded_events(provider,'route',{'question':question,'available_tools':catalog,
            'display_date':display_date or datetime.now().astimezone().date().isoformat()},'',6.,progress)
        try:
            candidate=response.get('result',{}).get('choices',[])[:6]
            for c in candidate:
                if public_weather and c.get('tool')=='get_weather':raise ValueError('nonlocal weather cannot use local readings')
                if not isinstance(c,dict) or c.get('tool') not in NAMES and c.get('tool') not in LEGACY_NAMES and c.get('tool') not in ('web_search','city_weather','general_chat'):raise ValueError('invalid route')
                if set(c)-{'tool','parameters'} or not isinstance(c.get('parameters',{}),dict):raise ValueError('invalid parameters')
                from jsonschema import validate
                validate(c.get('parameters',{}),next(t['parameters'] for t in FULL_CATALOG if t['name']==c['tool']))
                if 'date' in c.get('parameters',{}):datetime.fromisoformat(c['parameters']['date'])
                # Host owns query scope: LLM cannot invent a floor, date or day count.
                params=c.setdefault('parameters',{})
                floor=re.search(r'(\d+)\s*(?:层|楼)',question)
                if c['tool']=='floor_state':
                    if floor:params['floor']=int(floor[1])
                    else:params.pop('floor',None)
                day=re.search(r'(?:近|最近|过去)(\d+)天',question)
                if 'days' in params:params['days']=int(day[1]) if day else 7 if '周' in question else 3
                if 'date' in params and not re.search(r'\d{4}[-年]|昨天|昨日|前天',question):params.pop('date')
            choices=candidate
        except AssertionError:raise
        except Exception:choices=[];route_failed=True
    if not choices or any(c['tool'] in ('web_search','city_weather','general_chat') for c in choices):
        if local_reading:return (yield from emit_result(no_local_information()))
        from .general_chat import events
        return (yield from events(question,provider,web=any(c['tool'] in ('web_search','city_weather') for c in choices),progress=progress,display_date=display_date))
    if any(c['tool']=='current_state' for c in choices) and not re.search(r'记录|历史|累计|截至|今天|充电|放电',question):
        choices=[c for c in choices if c['tool']!='storage_history']
    results=[]
    for choice in choices:
        name=choice['tool']
        if name not in LEGACY_NAMES and not results:yield {'type':'step','text':'正在查询相关数据…'}
        local_question=questions.get(json.dumps(choice,sort_keys=True,ensure_ascii=False),question)
        if name in LEGACY_NAMES:
            from jsonschema import validate
            validate(choice.get('parameters',{}),next(t['parameters'] for t in FULL_CATALOG if t['name']==name))
            # Tool is already selected by the full catalogue. No second selection call.
            from .chat_engine import single_events
            g=single_events(local_question,data,row,provider,display_date,display_time,
                progress.start+30.,progress,selected_choice=choice)
            while True:
                try:
                    event=next(g)
                    if event['type'] not in ('done','answer_delta'):yield event
                except StopIteration as end:r=end.value;break
            r['reason']='answered'
            if not r['known']:r['answer']=NO_DATA;r['needs_human']=False
        else:
            yield {'type':'tool_start','tool':name,'args':choice.get('parameters',{}),'name':NAMES[name][0]}
            start=time.monotonic()
            try:r=execute_choice(choice,local_question,data,row,display_date,display_time)
            except Exception:r={'answer':NO_DATA,'known':False,'needs_human':False,'grounded':True,'reason':'answered','tool_trace':[{'tool':name,'result':{'available':False}}]}
            yield {'type':'tool_end','tool':name,'ms':round((time.monotonic()-start)*1000,1),'summary':NAMES[name][0]+('查询完成。' if r['known'] else '暂无数据。')}
        if name not in LEGACY_NAMES and name!='tariff_periods' and r['known'] and re.search(r'为什么|为何|怎么办|怎么处理|如何处理|建议',question) and chat_llm_status(provider, get_llm_status)['mode']=='real':
            from .chat_sentence_stream import stream_answer
            provider=provider or OpenAICompatibleProvider()
            g=stream_answer(provider,local_question,name,r,row,progress.start+30.,progress)
            while True:
                try:
                    event=next(g)
                    if event['type']!='answer_delta':yield event
                except StopIteration as end:r=end.value;break
        if not r['known']:
            # Actual local lookup failed: report this number unavailable, and include
            # related verified local values, never public facts as replacement readings.
            try:
                related=execute_choice({'tool':'storage_history' if name=='storage_history' else 'building_state'},
                    '储能电量' if name=='storage_history' else '运行概览',data,row,display_date,display_time)
                if related['known']:
                    r['answer']=NO_DATA+'当前可查到：'+related['answer']
                    r['tool_trace']+=related['tool_trace']
            except Exception:pass
        results.append(r)
    result={**results[-1],'answer':''.join(dict.fromkeys(r['answer'] for r in results)),
        'known':all(r['known'] for r in results),'grounded':all(r['grounded'] for r in results),
        'needs_human':any(r['needs_human'] for r in results),'tool_trace':[t for r in results for t in r['tool_trace']],
        'reason':'answered',
        'explanation_source':'llm' if any(r.get('explanation_source')=='llm' for r in results) else 'template',
        'llm_mode':'real' if any(r.get('explanation_source')=='llm' for r in results) else 'rule',
        'llm_called':any(r.get('llm_called',False) for r in results),
        'phase_timings':[p for r in results for p in r.get('phase_timings',[])]}
    return (yield from emit_result(result))
