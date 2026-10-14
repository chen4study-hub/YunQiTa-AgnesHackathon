"""Question-scoped checks supplement, never replace, grounding and tool checks."""
import re
from src.agent.agent_validation import validate_answer, output_issue
from src.agent.agent_relevance import relevant


def reading(answer, value, unit):
    if value is None:
        return False
    plain=answer.replace(',', '')
    numbers=re.findall(r'(?<![\d.])(-?\d+(?:\.\d+)?)\s*'+re.escape(unit)+r'(?![A-Za-z])',plain)
    return any(abs(float(n)-float(value))<=.051 for n in numbers)


def no_local_identity(answer):
    clauses=re.split(r'[。！？\n]',answer)
    absent=r'系统里没有|查不到|没有(?:相关)?(?:公开)?(?:信息|记录)|没有.*记录|(?:没有|未|没).*查到|缺少.*(?:信息|记录)'
    refusal=any(re.search(r'业主|物业',s) and re.search(absent,s) for s in clauses) or '系统里没有' in answer
    assertion=re.search(r'(?:业主|物业公司)\s*(?:是|为|叫|名为)\s*[^，。！？\n]+',answer)
    return bool(refusal and not assertion)


def check(case, answer, records):
    if not answer or output_issue(answer) or re.search(r'</?think\b', answer, re.I):
        return False
    # The exact numeric, source, required-tool and comparison checks still apply.
    cleaned,issues=validate_answer(answer,records,case['question'])
    if issues or not cleaned:
        return False
    kind=case.get('semantic_check')
    results=[t for r in records if r.get('success') for t in r.get('trace',[])]
    wanted=case.get('tool')
    result=next((t['result'] for t in results if t['tool']==wanted or (wanted in ('hvac_compare','compare_costs') and t['tool'] in ('hvac_compare','compare_costs'))),{})
    if kind=='no_local_identity':
        return no_local_identity(answer)
    if kind=='host_date':
        from datetime import date
        dates=[t['result'].get('display_date') for t in results if t['tool']=='get_time']
        return any(d and (d in answer or re.search(str(date.fromisoformat(d).month)+r'\s*月\s*'+str(date.fromisoformat(d).day)+r'\s*日',answer)) for d in dates)
    if kind=='pv_power':
        return any(reading(answer,t['result'].get('pv_kw'),'kW') for t in results if t['tool'] in ('current_energy','pv_generation')) and '光伏' in answer and 'kWh' not in answer
    if kind=='hvac':
        from src.agent.chat_sentence_stream import exclusion_present
        if not result or not result.get('comparison_available'):return False
        fields=[('before_setpoint_c','°C'),('after_setpoint_c','°C'),('before_cost','元'),('after_cost','元'),('before_peak_kw','kW'),('after_peak_kw','kW')]
        if not all(reading(answer,result.get(f),u) for f,u in fields):return False
        negative=result.get('savings_cny',0)<0
        value=result.get('extra_cost_cny') if negative else result.get('savings_cny')
        direction=bool(re.search(r'多花|增加|增至|增加至|上升',answer)) if negative else bool(re.search(r'节省|减少|降低|下降',answer))
        return direction and reading(answer,value,'元') and ('可自动调度' in answer or '计入时段' in answer) and '不按整天' in answer and all(exclusion_present(answer,e) for e in result.get('excluded',[]))
    if kind=='energy_cost':
        return reading(answer,result.get('total_cost_cny'),'元')
    if kind=='pv_energy':
        return reading(answer,result.get('generation_kwh'),'kWh')
    if kind=='handoff':
        return '值班' in answer and not re.search(r'没有转人工|未转人工|无需人工',answer) and bool(result)
    if kind=='energy_kwh':
        return reading(answer,result.get('total_kwh'),'kWh')
    if kind=='floor_field':
        f=result.get('floor',{});field=case['expected_field']
        return reading(answer,f.get(field),case['expected_unit']) and bool(re.search(str(f.get('floor'))+r'\s*层',answer))
    if kind=='building_field':
        return reading(answer,result.get('environment',{}).get(case['expected_field']),case['expected_unit'])
    if kind=='storage_field':
        return reading(answer,result.get(case['expected_field']),'kWh') and case['expected_label'] in answer
    if kind=='lift_field':
        states=result.get('states',[])
        requested=set(re.findall(r'(?<![A-Za-z0-9])([LH]\d+)(?![A-Za-z0-9])',case['question'],re.I))
        states=[s for s in states if not requested or s['id'] in {x.upper() for x in requested}]
        if not states or (requested and {s['id'] for s in states}!={x.upper() for x in requested}):return False
        for s in states:
            match=re.search(r'(?<![A-Za-z0-9])'+re.escape(s['id'])+r'(?![A-Za-z0-9])(.*?)(?=[LH]\d+|[。\n]|$)',answer,re.S)
            if not match or not reading(match[1],s.get(case['expected_field']),case['expected_unit']):return False
        return True
    if kind=='lift_health':
        diagnosis=bool(re.search(r'(?:没有|无|未提供).*?(?:设备故障诊断|故障诊断|健康诊断)|不能.*(?:健康|正常)|不.*(?:证明|判断).*?(?:健康|正常)|(?:故障诊断|健康诊断).*?(?:缺失|未提供|查不到|没有)',answer))
        unsupported=re.search(r'(?:均|都|各电梯).*?(?:正常|无故障|没有故障)',answer)
        return bool(result.get('states')) and diagnosis and '层' in answer and not unsupported
    if kind=='alerts_count':
        count=result.get('count')
        return (count==0 and bool(re.search(r'(?:没有|暂无|无)\s*(?:告警|报警)|0\s*条.*(?:告警|报警)',answer))) or (count is not None and str(count)+' 条' in answer)
    if kind=='receipt':
        elapsed=reading(answer,result.get('elapsed_ms'),'ms') or reading(answer,result.get('elapsed_ms'),'毫秒')
        return elapsed and bool(re.search(r'(?<!\d)'+str(result.get('count'))+r' 条',answer)) and 'BA/EMS' in answer and '日志回执' in answer
    if kind=='news':
        public=[r['data'] for r in records if r.get('success') and isinstance(r.get('data'),dict) and r['data'].get('recent_news')]
        if not public:
            return False
        sources=[s for r in public for s in r.get('sources',[])]
        if not sources:
            return answer.strip() == '没查到相关报道。'
        from datetime import datetime,timedelta,timezone
        today=datetime.now(timezone.utc).date()
        return all(relevant(case['question'],s) and today-timedelta(days=14)<=datetime.fromisoformat(s['published_at']).date()<=today for s in sources) and any(s['url'] in answer for s in sources)
    return True
