"""Small host projections of trusted context, never user/assistant numbers."""
import re
from .answer_grounding import raw_items


def reference(question, prior):
    items=raw_items(prior)
    def latest(names):
        return next((t['result'] for t in reversed(items) if t['tool'] in names),None)
    if re.fullmatch(r'刚才电池电量是多少[？?。\s]*只说这个读数[。\s]*',question):
        r=latest({'current_state'})
        if r and r.get('soc_percent') is not None:return f'储能电量 {r["soc_percent"]:,.1f}%。'
    if re.fullmatch(r'(?:那|那么)?湿度(?:呢|多少|是多少)?[？?。\s]*',question):
        r=latest({'get_weather'})
        if r and r.get('scope')=='current':
            h=(r.get('hours') or [{}])[0];value=h.get('humidity_percent',h.get('relative_humidity_pct'))
            if value is not None:return f'当前室外湿度 {value:,.1f}%。'
    if re.fullmatch(r'刚才光伏的功率再说一遍[。？?\s]*',question):
        r=latest({'current_energy'})
        if r and r.get('pv_kw') is not None:return f'光伏功率 {r["pv_kw"]:,.1f} kW。'
    if re.fullmatch(r'刚才的峰值时间再说一遍[。？?\s]*',question):
        r=latest({'forecast_peak'})
        if r and r.get('hour') is not None:
            return ('次日 ' if r.get('day_label')=='次日' else '')+f'{r["hour"]:02d}:{r["minute"]:02d}。'
    if re.fullmatch(r'刚才的比较排除了哪些时段[？?]\s*请列出全部时间和原因[。\s]*',question):
        r=latest({'compare_costs','hvac_compare'})
        if r is not None:
            excluded=r.get('excluded',[])
            if not excluded:return '刚才比较没有排除时段。'
            return '未计入时段：'+'；'.join(('次日 ' if e['day_label']=='次日' else '')+f'{e["hour"]:02d}:{e["minute"]:02d}（{e["reason"]}）' for e in excluded)+'。'
    return ''


def resolve_hvac(question, history):
    if re.search(r'比刚才的设定.*调[低高].*度',question) and '空调' not in question:
        users=[t.get('content','') for t in (history or []) if t.get('role')=='user']
        if users and '空调' in users[-1]:return '空调'+question
    return question
