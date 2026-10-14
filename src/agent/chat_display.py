"""Chat-only reading precision; source URLs, clocks, dates and counts unchanged."""
import re
from decimal import Decimal, ROUND_HALF_UP

READING = re.compile(r'(?<![A-Za-z0-9_.])([-+]?\d[\d,]*(?:\.\d+)?)\s*(元\s*/\s*kWh|kWh|kW|元|°C|%|mm|ppm|μg/m³|µg/m³|m³/h|毫秒|ms)(?![A-Za-z])')


def reading_text(text):
    from .answer_filter import strip_thoughts
    text = strip_thoughts(text)
    def replace(match):
        raw=match[1].replace(',','')
        unit=re.sub(r'\s+','',match[2])
        if unit=='元/kWh':return f'{Decimal(raw):,.2f} 元/kWh'
        value=Decimal(raw).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
        return f'{value:,.1f}'+('' if unit=='%' else ' ')+unit
    # Never rewrite numbers in a verified source URL.
    def prose(part):
        part = READING.sub(replace, part)
        part = re.sub(r'(?<![A-Za-z0-9_.])([\d,]+)\s*(人|条)', lambda m:f'{int(m[1].replace(",","")):,} {m[2]}', part)
        from .answer_scope import compact_day_words
        return compact_day_words(part)
    return ''.join(part if part.startswith(('https://','http://')) else prose(part)
        for part in re.split(r'(https?://[^\s<>）)]+)',text))
