"""Sentence-gated streaming: raw upstream fragments never become public events."""
import re,time,queue,threading
from .display_text import display_evidence,render_public_fields,numeric_tokens,DISPLAY_INSTRUCTION,ungroup_text,number_text
from .chat_evidence import compact_evidence,prompt_view,required_items,required_instruction,short_reference
from .numeric_prompt import allowed_numbers
from .orchestrator import check_grounding
from .prose_repair import repair_prose
from .provider import read_key

SLOTS=threading.BoundedSemaphore(4)
FIRST_TOKEN_SECONDS=12.
PROGRESS_ID='chat-answer-wait'


def safe_sentence(sentence,tool,result,row,evidence,diagnostics=None):
    try:
        text=validate_sentence(sentence,tool,result,row,evidence)
        if not text and diagnostics is not None:diagnostics['scope_or_format']=diagnostics.get('scope_or_format',0)+1
        return text
    except (ValueError,TypeError,KeyError,OverflowError) as exc:
        code=str(exc) if str(exc) in ('prose_repair_failed','numeric_grounding_failed','unit_meaning_failed','unsupported_savings_claim','internal_policy_wording') else 'validation_exception'
        if diagnostics is not None:diagnostics[code]=diagnostics.get(code,0)+1
        return ''


def validate_sentence(sentence,tool,result,row,evidence):
    key,_=read_key()
    if key and key in sentence:return ''
    if tool=='get_time':
        # Host clock/date is an explicit source; not historic origin clocks.
        reference=result['answer'];sentence=ungroup_text(sentence)
        sentence=re.sub(r'(\d{1,2})[时点](\d{1,2})分',lambda m:f'{int(m[1]):02d}:{int(m[2]):02d}',sentence)
        if not check_grounding(sentence,evidence):return ''
        clocks=re.findall(r'\d{1,2}:\d{2}',sentence)
        if any(c not in reference for c in clocks):return ''
        if re.search(r'\d{4}[-年/]|星期|起报|当地|今天\s*\d{1,2}:',sentence):return ''
        if '月' in sentence:
            dates=re.findall(r'(\d+)\s*月\s*(\d+)\s*日',sentence);wanted=re.findall(r'(\d+)\s*月\s*(\d+)\s*日',reference)
            if not dates or dates!=wanted:return ''
        if not any(w in sentence for w in ('现在','今天是','未提供')):return ''
        return render_public_fields({'text':sentence})['text']
    if tool=='forecast_peak':
        sentence=re.sub(r'[，；]?不代表(?:次日|明天)完整全天[。！？]?', '。',sentence)
        if not re.search(r'[\u4e00-\u9fff]',sentence):return ''
    text,_=repair_prose(sentence,row['t'],evidence,row['agent']['selection_reason'] if tool=='selection_reason' else None)
    if not text:raise ValueError('prose_repair_failed')
    if not check_grounding(text,evidence):raise ValueError('numeric_grounding_failed')
    meanings=allowed_numbers(evidence)
    for m in re.finditer(r'([-+]?\d[\d,]*(?:\.\d+)?)\s*(kWh|kW|元|°C|%)',text):
        value=float(m[1].replace(',',''));unit=m[2]
        matching=[r for r in meanings if float(r['value'])==value and (unit in r['meaning'])]
        if unit=='kW':matching=[r for r in matching if 'kWh' not in r['meaning']]
        if not matching:raise ValueError('unit_meaning_failed')
    if tool not in ('hvac_compare','selection_reason') and re.search(r'节省|节费|省电费|收益',text):raise ValueError('unsupported_savings_claim')
    if tool=='selection_reason':
        savings=result['tool_trace'][-1]['result'].get('estimated_savings')
        for m in re.finditer(r'(?:节省|节费|省电费|收益)\s*([\d,.]+)\s*元',text):
            if savings is None or float(m[1].replace(',',''))!=round(savings,1) or savings<0:raise ValueError('unsupported_savings_claim')
    if tool=='hvac_compare':
        comparison=result['tool_trace'][-1]['result']
        if re.search(r'家用|单台空调|几毛钱|\d\s*%',text):return ''
        if comparison.get('savings_cny',0)<0 and re.search(r'费用差额|负值|节省|节费|省电费|收益|不(?:会|会自动)?(?:增加(?:电费|费用)|多花)',text):return ''
        if re.search(r'多花|增加电费',text):
            if not any(float(m[1].replace(',',''))==comparison.get('extra_cost_cny') for m in re.finditer(r'(?:多花|增加电费)\s*([\d,.]+)\s*元',text)):return ''
        for m in re.finditer(r'(?:峰值(?:增加|升高)|增加)\s*([\d,.]+)\s*kW',text):
            if float(m[1].replace(',',''))!=comparison.get('peak_increase_kw'):return ''
        for m in re.finditer(r'(?:峰值(?:降低|减少)|降低|减少)\s*([\d,.]+)\s*kW',text):
            if float(m[1].replace(',',''))!=comparison.get('peak_reduction_kw'):return ''
        for m in re.finditer(r'(?:节省|省电费|收益)\s*([\d,.]+)\s*元',text):
            if float(m[1].replace(',',''))!=comparison['savings_cny'] or comparison['savings_cny']<0:return ''
    if tool=='selection_reason' and any(w in sentence for w in ('容差','微差','首步','重规划')):raise ValueError('internal_policy_wording')
    if tool=='handoff_reason' and not result['needs_human'] and not any(w in text for w in ('没有转人工','未转人工','未转交人工')):return ''
    if tool=='handoff_reason' and result['needs_human'] and re.search(r'没有转人工|未转人工|无转人工|未转交人工|没有交值班人员',text):return ''
    if tool=='execution_receipt':
        if re.search(r'设备(?:已)?(?:执行完成|执行成功|确认执行)|设备已(?:完成|执行)',text) and not row['agent']['receipt'].get('device_connected'):return ''
        if not any(w in text for w in ('日志回执','日志确认','日志记录','不是实物','不代表设备')):
            if '回执' not in text:return ''
            # The final required-text gate supplies the log label once if needed.
    if tool=='forecast_peak':
        text=re.sub(r'[，；]?不代表[。！？]$', '。',text)
        if re.fullmatch(r'\s*次日完整全天[。！？]?\s*',text):return ''
        p=result['tool_trace'][-1]['result']
        clocks=re.findall(r'\d{1,2}:\d{2}',text)
        if any(c!=f"{p['hour']:02d}:{p['minute']:02d}" for c in clocks):return ''
        if p['day_label']=='今天' and any(w in text for w in ('次日','明天')):return ''
        if p['day_label']=='次日' and ('今天' in text or ('次日' not in text and re.search(r'kW|\d{1,2}:\d{2}',text))):return ''
        if 'kW' in text and p['scope']=='today_remaining' and '剩余' not in text:return ''
        # The next-day available range remains in the tool evidence, not a trailing disclaimer.
        # Refusal is an answer-level requirement: a sourced reading sentence
        # need not repeat the warning emitted in the following sentence.
    if tool=='hvac_compare' and ('元' in text or '节省' in text):
        if re.search(r'全天(?:可|预计|将|节省|电费|收益)|所有时段',text):return ''
        # Scope is checked across the complete answer, not repeated in each sentence.
    if tool=='get_weather':
        weather=result['tool_trace'][-1]['result']
        if any(w in text for w in ('等值班','人工','不是独立')):return ''
        if any('.' in m[1] for m in re.finditer(r'(\d+(?:\.\d+)?)%',text)):return ''
        if weather['scope']=='current' and (re.search(r'\d{1,2}:\d{2}|次日|今天|未来',text) or '当前' not in text):return ''
        if weather['scope']=='future_hours' and len(re.findall(r'\d{1,2}:\d{2}',text))!=1:return ''
    return render_public_fields({'text':text})['text']


def exclusion_present(text,e):
    clock=f"{e['hour']:02d}:{e['minute']:02d}"
    for sentence in re.split(r'[。！？\n]',text):
        for match in re.finditer(re.escape(clock),sentence):
            labels=list(re.finditer(r'今天|次日',sentence[:match.start()]))
            day=labels[-1][0] if labels else '今天'
            if day==e['day_label'] and e['reason'] in sentence:return True
    for m in re.finditer(r'(?:(次日)\s*)?(\d{2}):(\d{2})–(\d{2}):(\d{2})',text):
        prefix=re.split(r'[。！？\n]',text[:m.start()])[-1]
        labels=list(re.finditer(r'今天|次日',prefix))
        day='次日' if m[1] else (labels[-1][0] if labels else '今天')
        if day!=e['day_label']:continue
        value=e['hour']*60+e['minute']
        if int(m[2])*60+int(m[3])<=value<=int(m[4])*60+int(m[5]) and e['reason'] in (prefix+re.split(r'[。！？\n]',text[m.start():])[0]):return True
    return False


def item_present(item,text):
    value=item['value'];field=item.get('field')
    clauses=re.split(r'[，。；！？\n]',text)
    labels={'count':r'指令|条','elapsed_ms':r'耗时|毫秒',
        'before_setpoint_c':r'从|改前|原|当前|基准','after_setpoint_c':r'改为|改到|改至|改后|调整至|调至',
        'before_cost':r'从|改前|原','after_cost':r'变为|改后|调整后',
        'savings_cny':r'节省|节费|省|差额|费用差|收益|电费降|费用降|减少|降低|下降','accepted_hours':r'接受|可自动调度',
        'before_peak_kw':r'峰值|改前','after_peak_kw':r'峰值|变为|改后','peak_increase_kw':r'增加|升高','peak_reduction_kw':r'降低|减少',
        'extra_cost_cny':r'多花|增加电费','excluded_hours':r'排除|未计入','upper_grid_peak_kw':r'峰值','energy_cost_cny':r'电费',
        'pv_kw':r'光伏','grid_kw':r'电网','battery_kw':r'储能',
        'soc_percent':r'电量|SOC','hvac_setpoint_c':r'设定|温控','outdoor_temp_c':r'室外|气温',
        'estimated_savings':r'节省|节费|差额|增加电费'}
    for clause in clauses:
        if field in labels and not re.search(labels[field],clause):continue
        if any(abs(float(v)-value)<1e-7 for v in numeric_tokens(clause)):return True
    return False


def missing_items(required,text):
    # Validated sentences already match evidence units. A unique required numeric
    # value is covered even when the operator uses an unlisted synonym; only
    # equal-valued fields need semantic disambiguation.
    tokens=[float(v) for v in numeric_tokens(text)]
    return [i for i in required if not item_present(i,text) and not (
        sum(abs(i['value']-j['value'])<1e-7 for j in required)==1 and
        any(abs(i['value']-v)<1e-7 for v in tokens))]


def host_supplement(tool,result,missing,scope_missing,joined=''):
    missing=[i for i in missing if not item_present(i,joined)]
    if not joined and 'answer' in result:return render_public_fields({'text':result['answer']})['text']
    if not missing and not scope_missing:return ''
    if tool=='execution_receipt':
        r=result['tool_trace'][-1]['result']
        parts=[]
        if any(i.get('field','count')=='count' for i in missing):parts.append(f"记录 {r['count']} 条指令")
        if any(i.get('field','elapsed_ms')=='elapsed_ms' for i in missing):parts.append(f"耗时 {r['elapsed_ms']:.1f} 毫秒")
        prefix='' if 'BA/EMS' in joined and '日志回执' in joined else ' BA/EMS 下发日志回执'
        return prefix+'，'.join(parts)+'。' if parts or prefix else ''
    if tool=='forecast_peak':
        r=result['tool_trace'][-1]['result'];parts=[]
        if any(i['value']==r['peak_kw'] for i in missing):parts.append(f"{'今天剩余预测小时内' if r['scope']=='today_remaining' else '本次可用预测小时内'}，峰值约 {r['peak_kw']:.1f} kW。")
        if any(i['value']==r['hour'] for i in missing):parts.append(f"峰值时刻为{r['day_label']} {r['hour']:02d}:{r['minute']:02d}。")
        # No next-day disclaimer appended to the answer.
        if r['abstain'] and not any(w in joined for w in ('人工','门控','拒绝','暂不自动执行')):parts.append('这个时段预测把握不大，暂不自动执行。')
        return render_public_fields({'text':''.join(parts)})['text']
    if tool=='hvac_compare':
        r=result['tool_trace'][-1]['result'];parts=[]
        labels={'before_setpoint_c':('改前设定','°C'),'after_setpoint_c':('改后设定','°C'),
            'before_cost':('计入时段改前电费','元'),'after_cost':('计入时段改后电费','元'),
            'before_peak_kw':('计入时段改前电网峰值','kW'),'after_peak_kw':('计入时段改后电网峰值','kW'),
            'peak_increase_kw':('电网峰值增加','kW'),'peak_reduction_kw':('电网峰值降低','kW'),
            'extra_cost_cny':('预计多花','元'),'savings_cny':('预计可节省','元'),'accepted_hours':('可自动调度','个小时'),'excluded_hours':('未计入','个小时')}
        for i in missing:
            field=i.get('field') or next((k for k in labels if r[k]==i['value']),'savings_cny')
            label,unit=labels[field];parts.append(f"{label} {i['value']:.1f} {unit}。")
        if '可自动调度' not in joined and not any(i.get('field')=='accepted_hours' for i in missing):parts.append(f"可自动调度 {r['accepted_hours']} 个小时。")
        if '未计入' not in joined and not any(i.get('field')=='excluded_hours' for i in missing):parts.append(f"未计入 {r['excluded_hours']} 个小时。")
        if '只覆盖' not in joined:parts.append('本次只覆盖可自动调度时段，不按整天计算。')
        missing_exclusions=[e for e in r['excluded'] if not exclusion_present(joined,e)]
        if missing_exclusions:parts.append('未计入时段：'+'；'.join(f"{e['day_label']} {e['hour']:02d}:{e['minute']:02d}（{e['reason']}）" for e in missing_exclusions)+'，请值班人员检查表计和设备记录。')
        # One compact supplemental sentence rather than one sentence per numeric leaf.
        return render_public_fields({'text':'；'.join(p.rstrip('。') for p in parts)+'。' if parts else ''})['text']
    if missing and not scope_missing and tool in ('selection_reason','current_state','current_energy'):
        units={'峰值':'kW','功率':'kW','电费':'元','电量':'%','SOC':'%','设定':'°C','气温':'°C','费用':'元'}
        parts=[]
        for i in missing:
            label=i['meaning'].split(' / ')[0];unit=next((u for word,u in units.items() if word in label),'')
            label=re.sub(r'\(.*?\)','',label)
            parts.append(f"{label} {i['value']:g}"+(' '+unit if unit and unit!='%' else unit))
        return '，'.join(parts)+'。'
    # Emit only reference sentences that supply a missing value/text item.
    parts=[]
    for sentence in re.split(r'(?<=[。！？!?])',render_public_fields({'text':result['answer']})['text']):
        if not sentence.strip() or sentence in joined:continue
        if not joined or any(item_present(i,sentence) for i in missing) or any(s not in joined and s in sentence for s in result.get('required_text',[])):
            parts.append(sentence)
    return ''.join(parts)


def stream_answer(provider,question,tool,result,row,deadline,progress=None):
    from .chat_engine import ProgressClock
    progress=progress or ProgressClock()
    evidence=display_evidence(compact_evidence(result['tool_trace']),row['t'],row)
    if tool=='get_time':evidence={'tools':result['tool_trace']}
    required=required_items(result);reference=short_reference(result)
    payload={'question':question,'selected_tool':tool,'tools':prompt_view(evidence),'origin':row['t'],
        'grounded_reference':reference,'needs_human':result['needs_human'],'required_answer_values':required,
        'required_answer_text':result.get('required_text',[]),
        'allowed_numeric_instruction':'数字须匹配下列值及含义，不从路径/日期推导新数字；kW是功率，kWh是电量，百分数不再换算。禁止非实测/推算/沿用/估算/估计。'+
            '\n'.join(f"{i['value']} | {i['meaning']}" for i in allowed_numbers(prompt_view(evidence)))+
            ('\nRelative clocks use今天/次日 as grounded_reference before host compaction.' if tool!='get_time' else ''),
        '_wait_seconds':max(.05,deadline-time.monotonic())}
    if tool=='hvac_compare':payload['answer_style']='用两到三句话。第一句说明温度及改前改后电费；savings_cny为负时只用extra_cost_cny正数写预计多花 X 元，不写负值费用差额；第二句说明同一批时段的电网峰值改前/改后及增加或降低量；之后说明只覆盖可自动调度的小时及未计入数量，并合并排除时间范围和原因。不用家用空调百分比或单台空调费用。不要逐项罗列、不要重复免责声明。'
    box=queue.Queue(maxsize=64);cancel=threading.Event();start=time.monotonic()
    def put(item):
        while not cancel.is_set():
            try:box.put(item,timeout=.1);return
            except queue.Full:pass
    def work():
        g=None
        try:
            g=provider.chat_stream(payload)
            for item in g:
                if cancel.is_set():break
                put(item)
        except AssertionError as exc:put({'type':'worker_error','error':exc})
        except Exception:put({'type':'done','llm':{'mode':'rule','reason':'chat_provider_failed'}})
        except BaseException as exc:put({'type':'worker_error','error':exc})
        finally:
            if g is not None:
                try:g.close()
                except Exception:pass
            put({'type':'end'});SLOTS.release()
    if not SLOTS.acquire(blocking=False):return {**result,'llm':{'mode':'rule','reason':'chat_deadline_or_busy'},'stream_emitted':False}
    threading.Thread(target=work,daemon=True).start()
    pending='';accepted=[];dropped=0;status={'mode':'rule','reason':'chat_deadline'};completed=False
    first_token=None;diagnostics={}
    from .answer_filter import ThinkFilter
    thought_filter=ThinkFilter()
    try:
        while time.monotonic()<deadline:
            now=time.monotonic()
            if getattr(provider,'_chat_cancel',None) is not None and provider._chat_cancel.is_set():break
            if first_token is None and now>=start+FIRST_TOKEN_SECONDS:
                status={'mode':'rule','reason':'chat_first_token_timeout'};break
            if not accepted:
                event=progress.event()
                if event:yield event
            wake=min(deadline,now+.1,now+progress.delay() if not accepted else deadline,start+FIRST_TOKEN_SECONDS if first_token is None else deadline)
            try:item=box.get(timeout=max(.001,wake-time.monotonic()))
            except queue.Empty:continue
            if item['type']=='worker_error':raise item['error']
            elif item['type']=='text_delta' and item.get('text'):
                if first_token is None:
                    if time.monotonic()>=start+FIRST_TOKEN_SECONDS:
                        status={'mode':'rule','reason':'chat_first_token_timeout'};break
                    first_token=time.monotonic()
                pending+=thought_filter.feed(item['text'])
                if len(pending)+sum(map(len,accepted))>4000:status={'mode':'rule','reason':'chat_answer_too_long'};break
                while True:
                    m=re.search(r'[。！？!?\n]',pending)
                    if not m:break
                    sentence,pending=pending[:m.end()],pending[m.end():]
                    safe=safe_sentence(sentence,tool,result,row,evidence,diagnostics)
                    if safe and safe not in accepted:accepted.append(safe);yield {'type':'answer_delta','text':safe,'sentence_source':'llm'}
                    else:dropped+=1
            elif item['type']=='done':status=item['llm'];completed=status.get('reason')=='call_succeeded';break
            elif item['type']=='end':break
        if completed and pending.strip():
            safe=safe_sentence(pending,tool,result,row,evidence,diagnostics)
            if safe and safe not in accepted:accepted.append(safe);yield {'type':'answer_delta','text':safe,'sentence_source':'llm'}
            else:dropped+=1
    finally:
        cancel.set()
        if not completed and hasattr(provider,'cancel_chat'):provider.cancel_chat()
    llm_sentence_count=len(accepted)
    joined=''.join(accepted)
    missing=missing_items(required,joined)
    # Values and scope are checked after stream; host reference is itself tool-verified.
    scope_missing=any(s not in joined for s in result.get('required_text',[]))
    if tool=='hvac_compare':
        comparison=result['tool_trace'][-1]['result']
        scope_missing=scope_missing or any(not exclusion_present(joined,e) for e in comparison['excluded'])
    if tool=='hvac_compare':scope_missing=scope_missing or not all(w in joined for w in ('可自动调度','未计入','只覆盖'))
    if missing or scope_missing or not accepted:
        yield {'type':'step','text':'正在查询相关数据…'}
        # A full grounded host sentence preserves unit/meaning/scope, no number-only patch.
        supplement=host_supplement(tool,result,missing,scope_missing,joined)
        if supplement and supplement not in joined:
            supplement=number_text(supplement)
            if not check_grounding(supplement,evidence):raise ValueError('host supplement not sourced')
            accepted.append(supplement);yield {'type':'answer_delta','text':supplement,'sentence_source':'template'}
    if not joined and status.get('reason')=='call_succeeded':status={**status,'reason':'chat_grounding_failed'}
    timing={'first_token_ms':round((first_token-start)*1000,1) if first_token is not None else None,
        'first_token_timeout_seconds':FIRST_TOKEN_SECONDS,'validation_failures':diagnostics}
    result={**result,'answer':''.join(accepted),'llm_called':True,'llm_mode':'real' if joined else 'rule',
        'answer_source':'llm_tools' if joined else 'deterministic_tools','explanation_source':'llm' if joined else 'template',
        'llm':{**status,**timing,'accepted_llm_sentences':llm_sentence_count,
            'dropped_sentences':dropped,'host_supplemented':bool(missing or scope_missing or not joined)},'stream_emitted':True,
        'phase_timings':[{'phase':'answer_stream',**timing,'accepted_llm_sentences':llm_sentence_count,'host_supplemented':bool(missing or scope_missing or not joined),'elapsed_ms':round((time.monotonic()-start)*1000,1),'reason':status.get('reason'),'transport_attempts':status.get('transport_attempts',[])}]}
    return result
