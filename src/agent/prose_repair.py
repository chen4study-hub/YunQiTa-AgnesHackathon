"""Deterministic, evidence-only sentence repair. Never invent replacements or save drafts."""
import math,re
from decimal import Decimal,ROUND_HALF_EVEN,InvalidOperation
from .display_text import public_text,numeric_tokens,NUMERIC_TOKEN,number_text,ungroup_text
from .selection import misleading_tradeoff


def allowed_numbers(evidence):
    values=set()
    def walk(v):
        if isinstance(v,bool):return
        if isinstance(v,(float,int)) and math.isfinite(v):values.add(Decimal(str(v)))
        elif isinstance(v,dict):
            for x in v.values():walk(x)
        elif isinstance(v,list):
            for x in v:walk(x)
    walk(evidence)
    return values


def repair_prose(text,origin,evidence,selection=None):
    """Normalize only exact/one-decimal-rounding matches to the supplied allowlist.

    Unknown/ambiguous numbers, dates and invalid tradeoff claims drop their entire
    sentence. No nearest-number guessing, extrapolation, reassigning units or host
    summary insertion. The caller still applies all scope/required-value checks.
    """
    allowed=allowed_numbers(evidence);kept=[]
    stats={'normalized_numbers':0,'dropped_sentences':0,'kept_sentences':0,'unknown_numeric_sentences':0}
    pieces=re.split(r'(?<=[。！？!?；;\n])|(?<=\.)\s+(?=[^\d])',text)
    for sentence in pieces:
        if not sentence.strip():continue
        unknown=False
        try:
            # Verify calendar/clock before any numeric normalization.
            for old,new in [('human_review','转人工'),('precool','提前预冷'),('dispatch','储能调度'),('hold','保持设定')]:
                sentence=re.sub(r'\b'+old+r'\b',new,sentence,flags=re.I)
            sentence=public_text(sentence.replace('非湿度实测','非实测湿度').replace('rule_conservative','保守调度').replace('rule_full','全额调度').replace('rule_hold','保持设定').replace('SOC','电量'),origin,evidence)
            sentence=ungroup_text(sentence)
            normalized=0
            def replace(m):
                nonlocal unknown,normalized
                value=Decimal(m[0])
                rounded=value.quantize(Decimal('0.1'),rounding=ROUND_HALF_EVEN)
                # Exact values at >1 decimal also reduce precision only if rounded
                # value is explicitly present, not merely close to any evidence.
                if '.' in m[0] and len(m[0].split('.')[-1])>1 and rounded in allowed:
                    normalized+=1;return format(rounded,'f')
                if value not in allowed:unknown=True
                return m[0]
            sentence=NUMERIC_TOKEN.sub(replace,sentence)
            if unknown:
                stats['unknown_numeric_sentences']+=1;raise ValueError('unsourced numeric sentence')
            if re.search(r'[A-Za-z]',re.sub(r'(?<![A-Za-z])BA/EMS(?![A-Za-z])|(?<=\d) (?:kWh|kW|°C)(?![A-Za-z])','',sentence)):
                raise ValueError('unmapped English prose')
            if re.search(r'\d+\.\d{2,}',sentence):raise ValueError('unsupported precision')
            if selection and misleading_tradeoff(sentence,selection):raise ValueError('invalid peak tradeoff')
            if len(re.findall(r'[\u4e00-\u9fff]',sentence))<2:raise ValueError('no substantive Chinese sentence')
            kept.append(number_text(sentence));stats['normalized_numbers']+=normalized;stats['kept_sentences']+=1
        except (ValueError,InvalidOperation):stats['dropped_sentences']+=1
    result=''.join(kept).strip()
    if result and any(Decimal(t) not in allowed for t in numeric_tokens(result)):raise ValueError('repair still ungrounded')
    stats['changed']=result!=text
    return result,stats
