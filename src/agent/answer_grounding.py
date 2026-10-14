"""Ground answers from unrounded tool traces, never from answer/reference prose."""
import re
from datetime import datetime, timedelta, date
from decimal import Decimal, ROUND_HALF_UP
from .display_text import numeric_tokens


def raw_items(records):
    return [t for r in records if r.get('success') for t in r.get('trace', [])
            if isinstance(t,dict) and isinstance(t.get('result'),dict)]


def raw_evidence(records):
    values=[];dates=set();clocks=set();ids=set()
    def number(v):
        if isinstance(v,bool):return
        if isinstance(v,(float,int)):
            values.extend([v,float(Decimal(str(v)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)),round(v,2)])
    def walk(obj):
        if isinstance(obj,dict):
            for k,v in obj.items():
                if isinstance(v,(float,int)) and not isinstance(v,bool):
                    number(v)
                    if k=='soc':number(v*100)
                elif isinstance(v,str):
                    if k in ('timestamp','t','origin','date','display_date'):
                        try:
                            stamp=datetime.fromisoformat(v.replace('Z','+00:00'))
                            dates.add(stamp.date().isoformat())
                            if 'T' in v:clocks.add(stamp.strftime('%H:%M'))
                        except ValueError:pass
                    if k in ('as_of','time','display_time','start_time','end_time','next_start_time'):
                        # Tariff intervals are explicit tool clocks, not ordinary
                        # numeric measurements. 24:00 is a valid interval endpoint.
                        match=re.fullmatch(r'(?:次日\s*)?(\d{2}:\d{2})',v)
                        if match:clocks.add(match[1])
                    if k=='id':ids.add(v)
                elif isinstance(v,(dict,list)):walk(v)
            if 'offset_ms' in obj:
                mins=int(obj['offset_ms'])//60000;clocks.add(f'{mins//60:02d}:{mins%60:02d}')
            if 'hour' in obj and 'minute' in obj:clocks.add(f"{obj['hour']:02d}:{obj['minute']:02d}")
            if all(k in obj for k in ('year','month','day')):
                try:dates.add(date(obj['year'],obj['month'],obj['day']).isoformat())
                except ValueError:pass
        elif isinstance(obj,list):
            for v in obj:walk(v)
    for item in raw_items(records):walk(item['result'])
    # Anchor clocks are supplied by the host, not model/ref prose.
    for r in records:
        ev=r.get('evidence')
        if isinstance(ev,dict) and isinstance(ev.get('origin_clock'),dict):
            c=ev['origin_clock'];clocks.add(f"{c['hour']:02d}:{c['minute']:02d}")
    return values,dates,clocks,ids


def numeric_issues(text,records):
    values,dates,clocks,ids=raw_evidence(records)
    issues=[]
    def calendar(m):
        raw=m[0];digits=[int(v) for v in re.findall(r'\d+',raw)]
        if len(digits)==3:good=f'{digits[0]:04d}-{digits[1]:02d}-{digits[2]:02d}' in dates
        else:good=any((int(d[5:7]),int(d[8:10]))==tuple(digits) for d in dates)
        if not good:issues.append('unsupported_date:'+raw)
        return ''
    text=re.sub(r'https?://[^\s<>）)]+','',text)
    text=re.sub(r'(?<!\d)(?:\d{4}-\d{2}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日)',calendar,text)
    def clock(m):
        if f'{int(m[1]):02d}:{int(m[2]):02d}' not in clocks:issues.append('unsupported_clock:'+m[0])
        return ''
    text=re.sub(r'(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])',clock,text)
    for ident in ids:
        text=re.sub(r'(?<![A-Za-z0-9])'+re.escape(ident)+r'(?![A-Za-z0-9])','',text)
    text=re.sub(r'PM2\.5|CO₂|CO2','',text,re.I)
    # Day count is an explicit range cardinality, not a measurement.
    lengths=[len(t['result']['days']) for t in raw_items(records) if isinstance(t['result'].get('days'),list)]
    values+=lengths
    for token in numeric_tokens(text):
        try:good=any(abs(float(token)-v)<1e-7 for v in values)
        except ValueError:good=False
        if not good:issues.append(token)
    return list(dict.fromkeys(issues))


def daily_issues(text,records):
    """Check date/value bindings, not only presence somewhere in the evidence."""
    issues=[]
    for t in raw_items(records):
        r=t['result'];days=r.get('days')
        if t['tool']!='energy_totals' or not isinstance(days,list) or not days:continue
        target=date.fromisoformat(r['date']);mapping={e['date']:e for e in days}
        for clause in re.split(r'[。；\n]',text):
            day=None
            m=re.search(r'(\d{1,2})\s*月\s*(\d{1,2})\s*日',clause)
            iso=re.search(r'\d{4}-\d{2}-\d{2}',clause)
            if iso:day=iso[0]
            elif m:day=f'{target.year:04d}-{int(m[1]):02d}-{int(m[2]):02d}'
            elif re.search(r'前前一天|前天',clause):day=(target-timedelta(days=2)).isoformat()
            elif re.search(r'前一天|昨天',clause):day=(target-timedelta(days=1)).isoformat()
            elif '今天' in clause:day=target.isoformat()
            if not day or '最近' in clause:continue
            entry=mapping.get(day)
            if not entry:continue
            for unit,value in [('kWh',entry['energy_kwh']['actual_kwh']),('元',entry['cost_cny'])]:
                ns=re.findall(r'([\d,.]+)\s*'+unit,clause)
                if ns and any(abs(float(n.replace(',',''))-value)>.051 for n in ns):issues.append({'reason':'daily_date_value_mismatch','date':day})
    return issues
