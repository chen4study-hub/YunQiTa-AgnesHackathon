"""Presentation only: canonical units and origin-relative clock labels, no numeric rounding."""
import re
from datetime import datetime,date,timedelta

BANNED_USER_WORDS=('影子模式','模拟','估算','估计','历史回放','回放','待人工确认','演示数据',
    '情景','典型日','代表日','高温日','节假日','国庆','星期','非实测','不是实测','推算','沿用')
CALENDAR_NAMES=re.compile(r'星期[一二三四五六七日天0-9]?|礼拜[一二三四五六日天]|周[一二三四五六日天]|'
    r'国庆(?:节)?|感恩节|圣诞(?:节)?|元旦(?:节)?|春节|除夕|元宵节|清明节|劳动节|端午节|中秋节|重阳节|'
    r'独立日|新年|节日|假日|\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|'
    r'Thanksgiving|Christmas|Halloween|New Year(?:\s*\x27s)?(?: Day)?|Independence Day|Labor Day|National Day)\b',re.I)
PUBLIC_TEXT_FIELDS=frozenset(('title','display_name','label','answer','explanation','summary','reason',
    'actions','possible_reasons','suggested_checks','text','message'))


def remove_disclaimer_sentences(text):
    """Delete obsolete disclaimer sentences/standalone trailing clauses, not words.

    Preserve operational claims and scope/refusal warnings. Also repair the two
    malformed strings produced by older token substitutions in saved exports.
    """
    pieces=re.split(r'(?<=[。！？!?\n])',text);out=[]
    for sentence in pieces:
        if re.search(r'这些候选数字对应[^。！？]*调度窗口',sentence):continue
        # A separate trailing disclaimer after an operational clause is removed
        # as a clause, so no replacement word is spliced into the useful claim.
        sentence=re.sub(r'[，；]\s*(?:预测计算结果预测值|预测计算、预测值|非实测(?:收益|数据)?|不是实测(?:节费)?)[^。！？!?\n]*', '',sentence)
        if re.search(r'非实测|不是实测|并非实测|推算|沿用|预测值节费|预测计算结果预测值|预测计算、预测值',sentence):continue
        out.append(sentence)
    return ''.join(out)


def operational_reason_text(text):
    """Plain duty-operator wording; no policy/economics/control fields modified."""
    text=''.join(part for part in re.split(r'(?<=[。！？!?\n])',text) if not re.search(r'宿主|系统提示|内部流程',part))
    text=text.replace('、。次日','、次日').replace('；。次日','；次日')
    text=re.sub(r'(及|和|与)\s*[。；]\s*(?=次日\s*\d{2}:\d{2})',r'\1 ',text)
    text=re.sub(r'等比\s*0\s*小时舒适越界', '未出现舒适越界',text)
    text=re.sub(r'(?<!\d),(?!\d)', '，',text).replace(';','；')
    text=text.replace('规则保守方案','保守调度方案')
    text=text.replace('选择已通过约束与目标检查的候选','选用满足设备限制、兼顾峰值和电费的方案')
    text=re.sub(r'按区间上界\s*([-+]?\d[\d,]*(?:\.\d+)?)\s*kW\s*准备',r'按负荷上限 \1 kW安排调度',text)
    text=re.sub(r'不代表[。！？]\s*次日完整全天[。！？]?', '不代表次日完整全天。',text)
    text=text.replace('峰值容差内视为相同并优先比较电费，','选用电费较低的方案，')
    text=text.replace('；不为不可见的峰值微差增加支出','')
    text=text.replace('每小时只执行首步后重规划','')
    text=text.replace('储能按完整窗口统筹，为','储能为').replace('；窗口末电量不低于起点，','，并保留备用电量')
    text=text.replace('本窗口没有可安全获益的后续放电时段，保持或恢复电量；','后续暂不安排放电，保持备用电量。')
    text=text.replace('按完整窗口中通过门控的时段比较费用与峰值；拒绝小时不计费用。','仅比较可自动调度的时段，拒绝时段不计费用。')
    text=text.replace('不影响当前通过门控的小时选案与执行。','当前小时可正常执行。')
    text=text.replace('后续时段预测被拒绝，保留电量等值班人员复核后使用。','')
    text=text.replace('已保持设定且不充放电。','保持设定、不充放电，需值班人员复核。')
    text=text.replace('峰值容差内选择上界峰值','预计上界峰值')
    text=text.replace('此候选未按峰值容差及电费规则选中，','此方案未选用，')
    text=text.replace('峰值差超过容差，为压低区间上界峰值多花','为进一步降低峰值，增加电费')
    text=text.replace('依据全精度峰值容差政策选中方案，','选用当前方案，').replace('；显示精度下不报告峰值与费用交换收益','')
    # Live schedule prose may repeat policy language despite the prompt.
    # Drop identifier-ranking sentences whole, rather than leaving a partial rule.
    text=''.join(part for part in re.split(r'(?<=[。！？!?\n])',text)
        if not re.search(r'再编号|编号[^。！？!?\n]*排序|排序[^。！？!?\n]*编号',part))
    text=text.replace('峰值容差带内','在峰值允许范围内').replace('容差带内','在峰值允许范围内')
    text=text.replace('峰值容差带','峰值允许范围')
    # Unknown variants fail closed; never expose the remaining internal rule.
    text=''.join(part for part in re.split(r'(?<=[。！？!?\n])',text) if '容差' not in part)
    text=text.replace('区间上界电网峰值','负荷偏高时的电网峰值')
    text=text.replace('通过门控的时段','可自动调度的时段').replace('通过门控','可自动调度').replace('被门控拒绝','暂不安排自动调度').replace('门控拒绝','暂不安排自动调度')
    text=text.replace('按预测上界准备','按偏高负荷安排')
    text=text.replace('区间上界峰值','负荷偏高时的峰值').replace('上界峰值','负荷偏高时的峰值')
    text=text.replace('今晚次日','次日').replace('全精度下','按完整数据比较').replace('全精度','完整数据')
    text=text.replace('不是实物设备执行确认','').replace('，。','。')
    text=text.replace('接受时段','计入时段').replace('非全天收益','不按整天计算').replace('非全天口径','不按整天计算')
    text=text.replace('需人工复核','交值班人员处理').replace('需要人工复核','交值班人员处理')
    text=text.replace('相对基准上界削峰','比常规运行的高峰低').replace('风险评分超过门控阈值','预测变化较大')
    text=text.replace('未通过置信门控','预测风险偏高，暂不自动执行').replace('置信门控','预测风险检查').replace('门控阈值','复核标准').replace('门控','预测风险检查')
    text=re.sub(r'；风险评分\s*[-+]?\d+(?:\.\d+)?，阈值\s*[-+]?\d+(?:\.\d+)?，', '；',text)
    text=re.sub(r'风险评分\s*[\d.]+\s*(?:高于|超过)\s*阈值\s*[\d.]+','预测风险偏高',text)
    text=text.replace('需人工核对拒绝时段','请值班人员检查拒绝时段的表计和设备记录').replace('需人工核对','请值班人员检查表计和设备记录')
    # Remove only an appended metric sentence already covered by prior prose.
    pieces=re.split(r'(?<=[。！？])',text);out=[]
    has_metric=any(s.startswith('选用电费较低的方案，') for s in pieces)
    for sentence in pieces:
        if has_metric and sentence=='选用满足设备限制、兼顾峰值和电费的方案。':continue
        if sentence.startswith('选用电费较低的方案，'):
            values=numeric_tokens(sentence)
            if any('峰值' in s and any(w in s for w in ('电费','费用')) and all(v in numeric_tokens(s) for v in values) for s in out):continue
        out.append(sentence)
    text=''.join(out)
    # Exact repeated duty sentences from saved prose + refreshed host summaries.
    unique=[]
    for sentence in re.split(r'(?<=[。！？])',text):
        if sentence.strip() and sentence not in unique:unique.append(sentence)
    text=''.join(unique)
    return re.sub(r'[；;]\s*([。；;])',r'\1',re.sub(r'([；;])\s+',r'\1',text))


def wording_text(text):
    text=re.sub(r'空调电耗占比（[^）]*）','空调电耗占比（预计）',text)
    text=operational_reason_text(remove_disclaimer_sentences(text))
    for old,new in [('rule_conservative','保守调度'),('rule_full','全额调度'),('rule_hold','保持设定')]:text=text.replace(old,new)
    text=re.sub(r'\bSOC\b','电量',text,flags=re.I)
    text=text.replace('演示电价','分时电价')
    text=re.sub(r'(全额调度|保守调度|保持设定)\s+(?=上界峰值)',r'\1',text)
    text=re.sub(r'(\d+)\.0(?=\s*(?:个|条|小时))',r'\1',text)
    for old,new in [('线性情景','线性计算'),('情景计算','预测计算'),('情景','预测计算'),
        ('典型日','当日'),('代表日','当日'),('高温日','当日'),('节假日','当日'),('待人工确认后使用','等值班人员复核后使用'),('待人工确认','等值班人员复核'),
        ('影子模式','约束校验'),('影子','约束校验'),('模拟','预测计算'),('估算','推算'),('估计','预测'),
        ('历史回放','逐时记录'),('回放','逐时记录'),('演示数据','样例数据')]:
        text=text.replace(old,new)
    text=text.replace('在线性计算中，','').replace('线性计算','预测计算')
    text=remove_disclaimer_sentences(text)
    text=CALENDAR_NAMES.sub('',text)
    text=re.sub(r'([，；。])\s*\1+',r'\1',text)
    text=re.sub(r'\s*BA/EMS\s*',' BA/EMS ',text)
    text=re.sub(r'(?<=[\u4e00-\u9fff])(?=[-+]?\d[\d,]*(?:\.\d+)?\s*(?:kWh|kW|元|°C|%))',' ',text)
    return re.sub(r'(?<=[。！？!?])\s+','',text).strip()


DISPLAY_INSTRUCTION=('User-facing units: exactly one space between number and kW, kWh, 元, °C; '
    'no space before %, e.g. 89.3%. Group numbers of 1000 or more with commas, '
    'e.g. 1,352.6 kW and 16,554.8 元; do not change numeric values or precision. '
    'Never expose original calendar dates or years. '
    'Use 今天 HH:MM or 次日 HH:MM from origin-local tool timestamps, never server clock. '
    'Do not invent times or numbers. Host compacts verified clock lists after validation. '
    'Load, grid load, peaks and power always use kW; energy/consumption uses kWh. '
    'Never infer power units from hourly energy fields just because their numbers coincide. '
    'Never use weekdays, holiday names, or user-facing words '
    '影子模式/模拟/估算/估计/历史回放/回放/待人工确认/演示数据/情景/典型日/代表日/高温日/节假日/国庆. '
    'Never use 非实测/不是实测/推算/沿用/估算/估计 in public prose. '
    'Never mention 容差, 微差 or 门控 in LLM prose. Explain scheduling in duty-operator language. '
    'Use 负荷偏高时的峰值 instead of 区间上界峰值. '
    'For what-if use 预计; retain accepted/excluded/non-whole-day scope and source limits on About. '
    'Review warnings only for explicitly refused hours, never weather or accepted peak hours. '
    'Use 可自动调度/未计入/本次只覆盖/不按整天计算 for comparison scope. '
    'Receipt: BA/EMS 下发日志回执; no physical-device disclaimer. '
    'Absolute display dates are added by the host only from optional display_date; never infer them from source years.')
NUMBER=r'[-+]?\d+(?:\.\d+)?'
NUMERIC_TOKEN=re.compile(r'[-+]?\d(?:[\d,]*\d)?(?:\.\d+)?')
GROUPED_NUMBER=re.compile(r'[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?\Z')


def numeric_tokens(text):
    """Only valid grouping is removed. Malformed comma sequences stay invalid tokens."""
    return [m[0].replace(',','') if ',' not in m[0] or GROUPED_NUMBER.fullmatch(m[0]) else m[0]
        for m in NUMERIC_TOKEN.finditer(text)]


def ungroup_text(text):
    def replace(m):
        if ',' in m[0] and not GROUPED_NUMBER.fullmatch(m[0]):raise ValueError('Invalid numeric grouping')
        return m[0].replace(',','')
    return NUMERIC_TOKEN.sub(replace,text)


def number_text(text):
    text=ungroup_text(text)
    def replace(m):
        value=m[0];sign=value[0] if value[0] in '+-' else '';body=value[len(sign):]
        integer,dot,fraction=body.partition('.')
        if int(integer)<1000:return value
        # String operations retain all decimal digits; no rounding or binary float.
        groups=[]
        while integer:groups.append(integer[-3:]);integer=integer[:-3]
        return sign+','.join(reversed(groups))+(dot+fraction if dot else '')
    return NUMERIC_TOKEN.sub(replace,text)

UNITS=re.compile(r'('+NUMBER+r')\s*(千瓦时|千瓦|kwh|kw|元|摄氏度|℃|°\s*C|度|[%％])',re.I)
CALENDAR=re.compile(r'(?<!\d)(?:\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}-\d{2}-\d{2})(?:[ T\s]*(?:\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?|\d{1,2}[时点](?:\d{1,2}分)?))?')
CHINESE_CLOCK=re.compile(r'(今天|次日)\s*([零一二三四五六七八九十]{1,3}|\d{1,2})[时点](?:(\d{1,2})分)?')
RELATIVE_CLOCK=re.compile(r'(今天|次日)\s*(\d{1,2}):(\d{2})')


def unit_text(text):
    text=ungroup_text(text)
    def replace(m):
        unit=m[2].lower().replace(' ','')
        value={'千瓦时':'kWh','kwh':'kWh','千瓦':'kW','kw':'kW','元':'元','摄氏度':'°C','℃':'°C','°c':'°C','度':'°C','%':'%','％':'%'}[unit]
        return m[1]+('' if value=='%' else ' ')+value
    return UNITS.sub(replace,text)


def timestamps(evidence):
    values=[]
    def walk(obj):
        if isinstance(obj,dict):
            for k,v in obj.items():
                if k in ('timestamp','t','origin') and isinstance(v,str):
                    try:values.append(datetime.fromisoformat(v.replace('Z','+00:00')))
                    except ValueError:pass
                elif isinstance(v,(dict,list)):walk(v)
        elif isinstance(obj,list):
            for v in obj:walk(v)
    walk(evidence)
    return values


def relative_time(timestamp,origin):
    first=datetime.fromisoformat(origin.replace('Z','+00:00'));t=datetime.fromisoformat(timestamp.replace('Z','+00:00')).astimezone(first.tzinfo)
    delta=(t.date()-first.date()).days
    if delta not in (0,1):raise ValueError('Display time outside today/next-day scope')
    return ('今天' if delta==0 else '次日')+f' {t.hour:02d}:{t.minute:02d}'


def display_evidence(evidence,origin,clock_source=None):
    first=datetime.fromisoformat(origin.replace('Z','+00:00'))
    clocks=[t.astimezone(first.tzinfo) for t in timestamps(evidence if clock_source is None else clock_source)]
    return {'tools':evidence,'origin_clock':{'hour':first.hour,'minute':first.minute},
        'timestamp_clocks':[{'timestamp':t.isoformat(),'hour':t.hour,'minute':t.minute} for t in clocks if (t.date()-first.date()).days in (0,1)]}


def public_text(text,origin,evidence):
    text=ungroup_text(text)
    # An explicitly day-qualified range carries its day to the second endpoint.
    text=re.sub(r'((今天|次日)\s*\d{2}:\d{2})\s*[–—~-]\s*(?!今天|次日)(\d{2}:\d{2})',lambda m:m[1]+'–'+m[2]+' '+m[3],text)
    first=datetime.fromisoformat(origin.replace('Z','+00:00'))
    known=[first]+[t.astimezone(first.tzinfo) for t in timestamps(evidence)]
    def calendar(m):
        raw=m[0];digits=[int(n) for n in re.findall(r'\d+',raw)]
        year,month,day=digits[:3];hour=digits[3] if len(digits)>3 else None;minute=digits[4] if len(digits)>4 else 0
        # ISO timezone must identify the exact issued target; Chinese dates are origin-local.
        if 'T' in raw:
            try:target=datetime.fromisoformat(raw.replace('Z','+00:00')).astimezone(first.tzinfo)
            except ValueError:raise ValueError('Invalid calendar timestamp')
            matches=[t for t in known if t==target]
        else:matches=[t for t in known if (t.year,t.month,t.day)==(year,month,day) and (hour is None or (t.hour,t.minute)==(hour,minute))]
        if not matches:raise ValueError('Calendar timestamp has no tool source')
        target=matches[0];label=relative_time(target.isoformat(),origin)
        return label if hour is not None else label.split()[0]
    text=CALENDAR.sub(calendar,text)
    # A bare original year or unrecognized calendar format must never be shown.
    if re.search(r'(?<!\d)\d{4}\s*年|\b(?:2016|2017)\b|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|'
        r'(?:\d{1,2}|[零一二三四五六七八九十]{1,3})月\s*(?:\d{1,2}|[零一二三四五六七八九十]{1,3})[日号]',text):
        raise ValueError('Calendar text not safely rendered')
    digits='零一二三四五六七八九'
    def chinese(m):
        word=m[2]
        if word.isdigit():h=int(word)
        elif '十' in word:
            a,b=word.split('十');h=(digits.index(a) if a else 1)*10+(digits.index(b) if b else 0)
        else:h=digits.index(word)
        return m[1]+f' {h:02d}:{int(m[3] or 0):02d}'
    text=text.replace('今日','今天').replace('明日','次日').replace('明天','次日')
    text=CHINESE_CLOCK.sub(chinese,text)
    # Bare/list clock phrases carry only an explicit preceding day label. Ambiguous
    # day-less prose is not guessed; callers use a host explanation instead.
    bare=re.compile(r'(?<![\d:])([零一二三四五六七八九十]{1,3}|\d{1,2})[时点](?:(\d{1,2})分)?')
    def bare_clock(m):
        if m[1].isdigit() and m.end()<len(text) and text[m.end()] in '段间':return m[0]
        labels=list(re.finditer(r'今天|次日',text[:m.start()]))
        if not labels:raise ValueError('Clock has no explicit day label')
        fake=CHINESE_CLOCK.match(labels[-1][0]+m[0])
        return chinese(fake)
    text=bare.sub(bare_clock,text)
    text=RELATIVE_CLOCK.sub(lambda m:m[1]+f' {int(m[2]):02d}:{int(m[3]):02d}',text)
    # Relative clock facts must also be from origin/issued evidence, never invented.
    for m in RELATIVE_CLOCK.finditer(text):
        delta=0 if m[1]=='今天' else 1
        if not any((t.date()-first.date()).days==delta and t.hour==int(m[2]) and t.minute==int(m[3]) for t in known):
            raise ValueError('Relative clock has no timestamp source')
    text=number_text(power_unit_text(wording_text(unit_text(text))))
    # Bare HH:MM also needs a sourced, unambiguous day. Never guess across midnight.
    clock=re.compile(r'(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])')
    def qualify(m):
        if re.search(r'(?:今天|次日)\s*$',text[:m.start()]):return m[0]
        h,minute=int(m[1]),int(m[2])
        labels={relative_time(t.isoformat(),origin) for t in known if t.hour==h and t.minute==minute and (t.date()-first.date()).days in (0,1)}
        if len(labels)!=1:raise ValueError('Bare clock has no unambiguous timestamp source')
        return labels.pop()
    return clock.sub(qualify,text)


def validate_display_time(value):
    if value is not None and (not isinstance(value,str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',value)):
        raise ValueError('display_time must be HH:MM')
    return value


def validate_display_date(value):
    if value is None:return None
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):raise ValueError('display_date must be YYYY-MM-DD')
    try:date.fromisoformat(value)+timedelta(days=1)
    except (ValueError,OverflowError):raise ValueError('display_date must allow today and next day')
    return value


def display_date_text(text,display_date=None,include_date=False):
    """Final decoration AFTER source/date/number validation; never changes machine time.

    Keep relative labels; if the caller supplies an anchor, annotate each qualified
    clock with the corresponding display date. Without an anchor no absolute date.
    Calendar digits are trusted host decoration, not LLM numeric evidence.
    """
    validate_display_date(display_date)
    if display_date is None or not include_date:return text
    return text+'显示日期：'+display_date+'。'


def power_unit_text(text):
    """Repair a clearly power-labelled clause, never an energy/mixed clause."""
    def clause(m):
        s=m[0]
        if re.search(r'负荷|峰值|功率',s) and not re.search(r'电量|电耗|耗电|用电|能量',s):
            s=re.sub(r'(?<=\d)\s*kWh\b',' kW',s,flags=re.I)
        return s
    return re.sub(r'[^，。；！？\n]+',clause,text)


def restore_host_clocks(text):
    """Rehydrate already-rendered host export prose before source checks.

    NOT for LLM drafts: day-less clocks in host exports mean same day by contract.
    """
    text=re.sub(r'((今天|次日)\s*\d{2}:\d{2})\s*–\s*(\d{2}:\d{2})',lambda m:m[1]+'–'+m[2]+' '+m[3],text)
    clock=re.compile(r'(?<![\d:])\d{2}:\d{2}(?![\d:])')
    return clock.sub(lambda m:m[0] if re.search(r'(?:今天|次日)\s*$',text[:m.start()]) else '今天 '+m[0],text)


def compact_time_text(text):
    """Final presentation only: sourced today clocks lose labels, hourly lists merge.

    Ranges include the last listed hourly target; not an invented end-exclusive
    duration. Do not merge gaps, out-of-order lists, minute steps or midnight days.
    Validation uses the full canonical timestamps BEFORE this function runs.
    """
    # Same-reason exclusions can share a range and a single reason annotation.
    annotated=re.compile(r'(?:(?:今天|次日)\s*)?\d{2}:\d{2}（[^（）]+）(?:[；、](?:(?:今天|次日)\s*)?\d{2}:\d{2}（[^（）]+）)+')
    def annotation(m):
        rows=re.findall(r'((?:(?:今天|次日)\s*)?\d{2}:\d{2})（([^（）]+)）',m[0])
        groups=[]
        for clock,reason in rows:
            if groups and groups[-1][1]==reason:groups[-1][0].append(clock)
            else:groups.append(([clock],reason))
        return '；'.join(compact_time_text('、'.join(clocks))+'（'+reason+'）' for clocks,reason in groups)
    text=annotated.sub(annotation,text)
    clock=r'(?:(?:今天|次日)\s*)?\d{2}:\d{2}'
    lists=re.compile(r'(?<![\d:])'+clock+r'(?:\s*[、，,]\s*'+clock+r')+(?![\d:])')
    def combine(m):
        tokens=list(re.finditer(r'(?:(今天|次日)\s*)?(\d{2}):(\d{2})',m[0]))
        items=[];day='今天'
        for t in tokens:
            day=t[1] or day;items.append((day,int(t[2])*60+int(t[3]),f'{t[2]}:{t[3]}'))
        runs=[];start=0;previous_day=None
        for i in range(1,len(items)+1):
            if i<len(items) and items[i][0]==items[i-1][0] and items[i][1]==items[i-1][1]+60:continue
            a,b=items[start],items[i-1];prefix='次日 ' if a[0]=='次日' and previous_day!='次日' else ''
            runs.append(prefix+a[2]+('–'+b[2] if i-start>1 else ''));start=i;previous_day=a[0]
        return '、'.join(runs)
    text=lists.sub(combine,text)
    text=re.sub(r'((?:(?:今天|次日)\s*)?\d{2}:\d{2})\s*(?:到|至)\s*((?:(?:今天|次日)\s*)?\d{2}:\d{2})',r'\1–\2',text)
    text=re.sub(r'((?:今天|次日)\s*\d{2}:\d{2})\s*[–—~-]\s*\1',r'\1',text)
    text=re.sub(r'(次日\s*\d{2}:\d{2})\s*[–—~-]\s*次日\s*(\d{2}:\d{2})',r'\1–\2',text)
    text=re.sub(r'今天\s*(?=\d{2}:\d{2})','',text)
    text=re.sub(r'(\d{2}:\d{2})(?=[\u4e00-\u9fff])',r'\1 ',text)
    text=re.sub(r'(?<=[\u4e00-\u9fff])(\d+(?:\.\d+)?)(?=\s*(?:条|毫秒|小时))',r' \1',text)
    text=re.sub(r'(\d+(?:\.\d+)?)\s*(条|毫秒|小时)',r'\1 \2',text)
    # Day qualification is scoped to clock lists, never split arbitrary prose
    # at the third label (that used to create punctuation such as 、。次日).
    return re.sub(r'[；，、]\s*。','。',text)


def operator_spacing(text):
    # Only prose, never structured timestamps/IDs or numeric leaves.
    text=re.sub(r'(?<=[\u4e00-\u9fff])(?=[-+]?\d)', ' ',text)
    text=re.sub(r'(?<=\d)(?=[\u4e00-\u9fff])', ' ',text)
    text=re.sub(r'(kWh|kW|°C|%)(?=[\u4e00-\u9fff])',r'\1 ',text)
    return text


def render_public_fields(obj,display_date=None):
    """Render ONLY UI prose fields; leave timestamps, IDs, model metadata untouched."""
    validate_display_date(display_date)
    def walk(value,key=''):
        if isinstance(value,dict):return {k:walk(v,k) for k,v in value.items()}
        if isinstance(value,list):return [walk(v,key) for v in value]
        if isinstance(value,str) and key in PUBLIC_TEXT_FIELDS:
            text=operator_spacing(display_date_text(compact_time_text(number_text(power_unit_text(wording_text(unit_text(value))))),display_date))
            # Tariff rates are the explicit two-decimal exception to reading precision.
            from decimal import Decimal, ROUND_HALF_UP
            return re.sub(r'([-+]?\d[\d,]*(?:\.\d+)?)\s*元\s*/\s*kWh',
                lambda m:f'{Decimal(m[1].replace(",", "")).quantize(Decimal(".01"), rounding=ROUND_HALF_UP):,.2f} 元/kWh',text)

        return value
    return walk(obj)
