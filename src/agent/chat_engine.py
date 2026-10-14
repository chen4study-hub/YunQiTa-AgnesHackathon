"""One grounded event pipeline used by JSON/chat and SSE/chat/stream."""
from src.api.rate_limit import chat_llm_status
import re
import time
import threading
import queue
from pydantic import BaseModel,ConfigDict,Field
from typing import Literal
from src.agent.orchestrator import check_grounding,rounded_tools,ungrounded_numbers,ENGLISH_ACTIONS
from src.agent.provider import get_llm_status,OpenAICompatibleProvider
from src.agent.chat_tools import execute,intent,TOOLS
from src.agent.numeric_prompt import numeric_instruction
from src.agent.selection import misleading_tradeoff
from src.agent.display_text import public_text,display_evidence,DISPLAY_INSTRUCTION,numeric_tokens,render_public_fields,validate_display_date,validate_display_time
from .chat_evidence import compact_evidence,required_items,required_instruction,prompt_view,short_reference

class ToolChoice(BaseModel):
    model_config=ConfigDict(extra='forbid')
    tool:Literal['get_time','get_weather','selection_reason','handoff_reason','execution_receipt','current_state','current_energy','forecast_peak','hvac_compare','unknown']
    setpoint_c:float|None=Field(default=None,ge=24,le=27,allow_inf_nan=False)

class ToolAnswer(BaseModel):
    model_config=ConfigDict(extra='forbid')
    answer:str=Field(min_length=1,max_length=2000)


def consume(generator):
    while True:
        try:next(generator)
        except StopIteration as end:return end.value

# Bounded provider operations; workers never emit events or store bodies/logs.
CALL_SLOTS=threading.BoundedSemaphore(4)


def bounded_call(provider,phase,payload,feedback,seconds):
    return consume(bounded_events(provider,phase,payload,feedback,seconds))


class ProgressClock:
    """One clock shared by selection, answer and compound questions."""
    def __init__(self):
        self.start=time.monotonic();self.elapsed=0
    def delay(self):return max(.001,self.start+self.elapsed+1.-time.monotonic())
    def event(self):
        elapsed=int(time.monotonic()-self.start)
        if elapsed<=self.elapsed:return None
        self.elapsed=elapsed
        return {'type':'progress','id':'chat-answer-wait','text':f'正在组织回答，已等待 {elapsed} 秒','elapsed_seconds':elapsed}


def bounded_events(provider,phase,payload,feedback,seconds,progress=None):
    if seconds<=0 or not CALL_SLOTS.acquire(blocking=False):return {'result':None,'llm':{'mode':'rule','reason':'chat_deadline_or_busy'}}
    box=queue.Queue(maxsize=1)
    def work():
        try:box.put(provider.chat_call(phase,payload,feedback))
        except AssertionError as exc:box.put(exc)
        except Exception:box.put({'result':None,'llm':{'mode':'rule','reason':'chat_provider_failed'}})
        except BaseException as exc:box.put(exc)
        finally:CALL_SLOTS.release()
    threading.Thread(target=work,daemon=True).start()
    start=time.monotonic();limit=min(seconds,8.);progress=progress or ProgressClock()
    while True:
        if getattr(provider,'_chat_cancel',None) is not None and provider._chat_cancel.is_set():
            return {'result':None,'llm':{'mode':'rule','reason':'chat_cancelled'}}
        left=limit-(time.monotonic()-start)
        if left<=0:return {'result':None,'llm':{'mode':'rule','reason':'chat_first_token_timeout' if seconds>=8 else 'chat_deadline'}}
        try:
            response=box.get(timeout=min(left,progress.delay(),.1))
            if isinstance(response,BaseException):raise response
            return response
        except queue.Empty:
            if time.monotonic()-start<limit:
                event=progress.event()
                if event:yield event

def legacy_events(question,data,row,provider=None,display_date=None,display_time=None):
    validate_display_date(display_date);validate_display_time(display_time)
    tasks=[]
    for part in re.split(r'[，,、；;？?]|(?:以及|还有|和)',question):
        if not part.strip():continue
        tool,_=intent(part)
        if tool!='unknown' and tool not in [intent(p)[0] for p in tasks]:tasks.append(part)
    if any(w in question for w in ('天气','湿度','室外','气温')) and any(w in question for w in ('几点','日期','几号','几月')) and not any(w in question for w in ('峰值','负荷','空调')):
        if not any(intent(p)[0]=='get_time' for p in tasks):tasks.insert(0,'今天几号' if any(w in question for w in ('日期','几号','几月')) else '现在几点')
        if not any(intent(p)[0]=='get_weather' for p in tasks):tasks.append('天气怎么样')
    progress=ProgressClock();deadline=progress.start+30.
    if len(tasks)<=1:return (yield from single_events(question,data,row,provider,display_date,display_time,deadline,progress))
    results=[]
    for task in tasks:
        g=single_events(task,data,row,provider,display_date,display_time,deadline,progress)
        while True:
            try:
                e=next(g)
                if e['type']!='done':yield e
            except StopIteration as end:results.append(end.value);break
    result={**results[-1],'answer':''.join(r['answer'] for r in results),
        'tool_trace':[t for r in results for t in r['tool_trace']],
        'phase_timings':[t for r in results for t in r.get('phase_timings',[])],
        'known':all(r['known'] for r in results),'grounded':all(r['grounded'] for r in results),
        'needs_human':any(r['needs_human'] for r in results),
        'explanation_source':'llm' if any(r['explanation_source']=='llm' for r in results) else 'template'}
    # Child sentence deltas have already been sent; no duplicate joined answer.
    yield {'type':'done',**{k:result[k] for k in ('known','grounded','needs_human','explanation_source','phase_timings')}}
    return result


def single_events(question,data,row,provider=None,display_date=None,display_time=None,deadline=None,progress=None,selected_choice=None):
    # Day wording is presentation only, after canonical clock/source validation.
    from .chat_tools import peak_scope
    tomorrow='明天' in question and peak_scope(question)=='next_day'
    g=_single_events(question,data,row,provider,display_date,display_time,deadline,progress,selected_choice)
    while True:
        try:
            event=next(g)
            if tomorrow and event['type']=='answer_delta':event={**event,'text':event['text'].replace('次日','明天')}
            yield event
        except StopIteration as end:
            result=end.value
            if tomorrow:result['answer']=result['answer'].replace('次日','明天')
            return result


def _single_events(question,data,row,provider=None,display_date=None,display_time=None,deadline=None,progress=None,selected_choice=None):
    # First yield does not parse exports, read provider config or wait for network.
    yield dict(type='step',text='正在查询相关数据…')
    validate_display_date(display_date)
    progress=progress or ProgressClock()
    deadline=deadline if deadline is not None else progress.start+30.;phases=[];called=False;failure={'mode':'rule','reason':'chat_validation_failed'}
    from src.data.replay_payload import ensure_hour
    row=ensure_hour(data,row)
    tool,setpoint=intent(question)
    if selected_choice is not None:tool,setpoint=selected_choice['tool'],selected_choice.get('parameters',{}).get('setpoint_c')
    expected_tool=tool;result=None;selection_status=None
    direct=tool in ('get_time','get_weather')
    status={'mode':'rule','reason':'direct_tool_answer'} if direct else chat_llm_status(provider, get_llm_status)
    def measured(phase,payload,feedback,seconds):
        start=time.monotonic();response=yield from bounded_events(provider,phase,{**payload,'_wait_seconds':max(.05,seconds-.2)},feedback,seconds,progress)
        phases.append({'phase':phase,'elapsed_ms':round((time.monotonic()-start)*1000,1),'reason':response['llm'].get('reason'),'transport_attempts':response['llm'].get('transport_attempts',[])})
        return response
    try:
        if status['mode']=='real':provider=provider or OpenAICompatibleProvider()
        if status['mode']=='real' and tool=='unknown':
            provider=provider or OpenAICompatibleProvider();called=True
            selection=yield from measured('select',{'question':question,'available_tools':TOOLS,'intent_hint':tool},'',min(10.,deadline-time.monotonic()))
            if selection['llm'].get('reason')=='call_succeeded':
                try:
                    choice=ToolChoice.model_validate(selection['result'])
                    if expected_tool!='unknown' and choice.tool!=expected_tool:raise ValueError('Question/tool mismatch')
                    if choice.tool=='hvac_compare' and choice.setpoint_c is None:raise ValueError('Missing setpoint')
                    tool,setpoint=choice.tool,choice.setpoint_c;selection_status=selection['llm']
                except Exception:
                    failure={'mode':'rule','reason':'chat_invalid_tool'}
                    yield dict(type='step',text='正在查询相关数据…')
                    provider=None
            else:
                failure=selection['llm'];provider=None
                yield dict(type='step',text='正在查询相关数据…')
        tools=execute(tool,question,data,row,setpoint,display_date=display_date,display_time=display_time)
        while True:
            try:yield render_public_fields(next(tools))
            except StopIteration as end:
                result=end.value;break
        streamed=False
        comparison=result['tool_trace'][-1]['result'] if tool=='hvac_compare' and result['tool_trace'] else {}
        direct_comparison=tool=='hvac_compare' and (comparison.get('comparison_available') is False or comparison.get('today_accepted_hours')==0)
        if not direct_comparison and status['mode']=='real' and provider is not None and result['known'] and hasattr(provider,'chat_stream'):
            from .chat_sentence_stream import stream_answer
            result=yield from stream_answer(provider,question,tool,result,row,deadline,progress)
            phases.extend(result.get('phase_timings',[]));streamed=result.pop('stream_emitted',False);called=True
            failure=result.get('llm',failure)
        elif not direct_comparison and status['mode']=='real' and provider is not None and result['known'] and tool!='get_time':
            called=True
            evidence=display_evidence(compact_evidence(result['tool_trace']),row['t'],row);feedback=''
            required=required_items(result);required_prompt=required_instruction(required)
            for attempt in range(2):
                response=yield from measured('answer',{'question':question,'selected_tool':tool,'tools':prompt_view(evidence),
                    'grounded_reference':short_reference(result),'needs_human':result['needs_human'],'origin':row['t'],
                    'required_answer_values':required,
                    'allowed_numeric_instruction':DISPLAY_INSTRUCTION+numeric_instruction(prompt_view(evidence))+'\n'+required_prompt+
                        ('\nWeather: follow current/future scope. Current: 当前室外 <temperature> °C，湿度 <integer humidity_percent>%。 No clock range. Future: list each supplied timestamp separately, never imply a shared reading for all hours. Provenance/disclaimers are on About.' if tool=='get_weather' else '')},feedback,min(18.,deadline-time.monotonic()))
                if response['llm'].get('reason')!='call_succeeded':
                    failure=response['llm'];yield dict(type='step',text='正在查询相关数据…');break
                try:
                    text=ToolAnswer.model_validate(response['result']).answer
                    if tool=='forecast_peak':text=re.sub(r'[，；]?不代表(?:次日|明天)完整全天[。！？]?', '。',text)
                except Exception:
                    failure={'mode':'rule','reason':'chat_invalid_answer'};break
                from .prose_repair import repair_prose
                text,repair=repair_prose(text,row['t'],evidence,row['agent']['selection_reason'] if tool=='selection_reason' else None)
                if not text:
                    failure={'mode':'rule','reason':'chat_grounding_failed','prose_repair':repair};feedback='No usable grounded sentences remain. Use the grounded reference.'
                    yield dict(type='step',text='正在查询相关数据…');continue
                missing=ungrounded_numbers(text,evidence)
                if missing or not check_grounding(text,evidence):
                    failure={'mode':'rule','reason':'chat_grounding_failed'}
                    feedback='Numbers without numeric tool source: '+', '.join(s[:24] for s in missing[:30])+'. Remove or replace with exact tool values.'
                    yield dict(type='step',text='正在查询相关数据…');continue
                if tool=='selection_reason' and misleading_tradeoff(text,row['agent']['selection_reason']):
                    failure={'mode':'rule','reason':'chat_peak_tradeoff_failed'}
                    feedback='Follow grounded_reference peak tolerance/cost policy; never pay for a zero or within-tolerance peak gain.';continue
                tokens=[float(x) for x in numeric_tokens(text)]
                missing_required=[i for i in required if not any(abs(v-i['value'])<1e-7 for v in tokens)]
                missing_text=tool=='selection_reason' and any(item not in text for item in result.get('required_text',[]))
                if missing_required or missing_text:
                    failure={'mode':'rule','reason':'chat_missing_answer_values','missing_required_values':missing_required}
                    feedback='Missing required values: '+required_instruction(missing_required)+'. Rewrite the complete answer, preserve scope.'
                    yield dict(type='step',text='正在查询相关数据…');continue
                if ENGLISH_ACTIONS.search(text) or any(w in text for w in ('影子','模拟','估算')):
                    failure={'mode':'rule','reason':'chat_answer_format_failed'};feedback='Use Chinese actions and required accepted-only comparison scope.';continue
                # Anchor relative date to origin, never server clock; no fabricated handoff.
                if tool=='forecast_peak':
                    peak=result['tool_trace'][-1]['result']
                    if peak['day_label'] not in text or (peak['day_label']=='今天' and any(w in text for w in ('次日','明天'))) or (peak['day_label']=='次日' and '今天' in text):
                        failure={'mode':'rule','reason':'chat_date_failed'};feedback='Use provided day_label 今天 or 次日 exactly; do not contradict it.';continue
                    if peak['scope']=='today_remaining' and '剩余' not in text:
                        failure={'mode':'rule','reason':'chat_scope_failed'};feedback='Preserve scope:今天剩余预测小时 or 次日本次可用预测小时非完整全天.';continue
                if tool=='hvac_compare':
                    comparison=result['tool_trace'][-1]['result']
                    if comparison.get('savings_cny',0)<0 and ('预计多花' not in text or re.search(r'费用差额|负值|节省|不(?:会|会自动)?(?:增加(?:电费|费用)|多花)',text)):
                        failure={'mode':'rule','reason':'chat_cost_direction_failed'};feedback='Use sourced positive extra_cost_cny and say 预计多花 X 元; do not expose negative savings.';continue
                    peak_error=any(float(m[2].replace(',',''))!=comparison.get('peak_increase_kw' if m[1]=='增加' else 'peak_reduction_kw') for m in re.finditer(r'(增加|降低|减少)\s*([\d,.]+)\s*kW',text))
                    if peak_error or re.search(r'家用|单台空调|几毛钱|\d\s*%',text):
                        failure={'mode':'rule','reason':'chat_peak_direction_failed'};feedback='Use compare_costs before_peak_kw/after_peak_kw and sourced increase or reduction only, no household percentages.';continue
                    # Scope explanation is mandatory; mere numeric presence cannot prove it.
                    missing_scope=not all(w in text for w in ('可自动调度','未计入','只覆盖'))
                    missing_exclusion=any(f"{e['day_label']} {e['hour']:02d}:{e['minute']:02d}" not in text or e['reason'] not in text for e in comparison['excluded'])
                    if missing_scope or missing_exclusion:
                        failure={'mode':'rule','reason':'chat_comparison_scope_failed'};feedback='Preserve accepted-only/non-whole-day scope, exclusion count and every excluded local time AND reason exactly from grounded_reference.';continue
                if tool=='get_weather' and any(w in text for w in ('推算','非实测','沿用','不是独立天气预报','等值班人员复核后使用')):
                    failure={'mode':'rule','reason':'chat_weather_format_failed'};feedback='Weather: only readings and time range; disclosures are on About.';continue
                if tool=='get_weather':
                    weather=result['tool_trace'][-1]['result']
                    invalid_humidity=any('.' in m[1] for m in re.finditer(r'(\d+(?:\.\d+)?)%',text))
                    invalid_scope=weather['scope']=='current' and (re.search(r'\d{1,2}:\d{2}|未来|次日|今天',text) or '当前' not in text)
                    if invalid_humidity or invalid_scope:
                        failure={'mode':'rule','reason':'chat_weather_format_failed'};feedback='Current weather: 当前室外 <temperature> °C，湿度 <integer humidity_percent>%。 No time range. Future weather: each supplied timestamp separately. Use humidity_percent, not raw decimals.';continue
                if result['needs_human'] and not any(w in text for w in ('人工','门控','拒绝','值班人员','暂不自动执行')):
                    failure={'mode':'rule','reason':'chat_missing_refusal_warning'};feedback='Mention human review/refused horizons.';continue
                if tool=='handoff_reason' and result['needs_human'] and re.search(r'没有转人工|未转人工|无转人工|未转交人工',text):
                    failure={'mode':'rule','reason':'chat_false_handoff'};feedback='This hour IS handed off; lack of takeover record does not mean not handed off. Say 交值班人员处理.';continue
                if tool=='handoff_reason' and not result['needs_human'] and not any(w in text for w in ('没有转人工','未转人工','未转交人工')):
                    failure={'mode':'rule','reason':'chat_false_handoff'};feedback='Current hour has NOT been handed to human. Say 没有转人工.';continue
                if tool=='execution_receipt' and not row['agent']['receipt'].get('device_connected') and (not any(w in text for w in ('不是实物','非实物','非设备','不代表设备','不是设备','日志回执','日志确认','日志记录')) or re.search(r'设备(?:已|实物)?(?:执行完成|执行成功|确认执行)|实物(?:设备)?(?:执行完成|执行成功)|设备已(?:完成|执行)',text)):
                    failure={'mode':'rule','reason':'chat_false_receipt'};feedback='Receipt is BA/EMS下发日志回执 only, not physical execution. State log receipt and ALL required values; remove device execution claims.';continue
                result.update(answer=text,answer_source='llm_tools',llm_called=True,llm_mode='real',llm={**response['llm'],'prose_repair':repair});break
            else:pass
        if result.get('answer_source')!='llm_tools':
            # Refused what-if/unknown: real tool choice may succeed without numeric answer composition.
            if selection_status is not None and not result['known']:
                result.update(llm_called=True,llm_mode='real',llm=selection_status)
            else:result.update(llm_called=called,llm_mode='rule' if called else status['mode'],llm=failure if called else status)
        result['phase_timings']=phases
        result['explanation_source']='llm' if result.get('answer_source')=='llm_tools' else 'template'
        result.pop('required_values',None);result.pop('required_text',None);result.pop('required_fields',None)
        result=render_public_fields(result)
        from .chat_display import reading_text
        result['answer']=reading_text(result['answer'])
        from .chat_tools import peak_scope
        if not streamed and '明天' in question and peak_scope(question)=='next_day':result['answer']=result['answer'].replace('次日','明天')
        # Buffer whole answer until validation; these are validated text chunks, not raw LLM tokens.
        if not streamed:
            for offset in range(0,len(result['answer']),48):yield dict(type='answer_delta',text=result['answer'][offset:offset+48])
        yield dict(type='done',known=result['known'],needs_human=result['needs_human'],grounded=result['grounded'],explanation_source=result['explanation_source'],phase_timings=phases,llm_reason=result['llm'].get('reason'))
        return result
    except AssertionError:
        raise
    except Exception:
        yield dict(type='error',message='工具数据暂不可用，未输出未经核验的答案。')
        result=dict(answer='不知道',known=False,needs_human=False,grounded=True,tool_trace=[],explanation_source='template',answer_source='deterministic_tools',llm_called=called,llm_mode='rule' if called else status['mode'],llm={'mode':'rule','reason':'chat_tool_unavailable'})
        yield dict(type='answer_delta',text=result['answer']);yield dict(type='done',known=False,needs_human=False,grounded=True,explanation_source='template')
        return result


def response_mode(value):
    """Composition mode, never inferred from configured provider availability."""
    phases=value.get('phase_timings',[])
    if any('first_token_timeout' in str(p.get('reason','')) for p in phases):
        return 'fallback'
    if 'first_token_timeout' in str(value.get('llm_reason','')):
        return 'fallback'
    return 'llm' if value.get('explanation_source')=='llm' else 'fallback'


def events(question,data,row,provider=None,display_date=None,display_time=None):
    from .chat_router import route_events
    from .chat_display import reading_text
    g=route_events(question,data,row,provider,display_date,display_time)
    try:
        while True:
            try:
                event=next(g)
                # Do not display the old generic query step. Keep specific steps.
                if event['type']=='step' and event.get('text')=='正在查询相关数据…':continue
                if event['type']=='answer_delta' and event.get('text')=='不知道':
                    from .building_tools import NO_DATA
                    event={**event,'text':NO_DATA}
                if event['type']=='answer_delta':event={**event,'text':reading_text(event['text'])}
                if event['type']=='done' and 'reason' not in event:
                    event={**event,'reason':'answered',
                        'needs_human':event.get('needs_human',False) if event.get('known') else False}
                if event['type']=='done':event={**event,'mode':response_mode(event)}
                yield event
            except StopIteration as end:
                result=end.value
                if not result.get('known') and result.get('reason')!='out_of_scope' and result.get('answer')=='不知道':
                    from .building_tools import NO_DATA
                    result['answer']=NO_DATA
                if not result.get('known'):result['needs_human']=False
                result.setdefault('reason','answered')
                result['answer']=reading_text(result.get('answer',''))
                result['mode']=response_mode(result)
                return result
    finally:g.close()
