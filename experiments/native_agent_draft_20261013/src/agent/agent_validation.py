"""Sentence-level safety: one model repair, then omit only invalid sentences."""
import re
from .display_text import BANNED_USER_WORDS, number_text, unit_text
from .orchestrator import ungrounded_numbers
from .general_chat import public_numeric_safe


def sentences(text):
    return [s for s in re.split(r'(?<=[。！？!?\n])', text) if s.strip()]


def validate_answer(text, records):
    issues, good = [], []
    evidence = [r['evidence'] for r in records if r.get('success') and r.get('evidence')]
    words = BANNED_USER_WORDS + ('演示', '容差', '门控', '区间上界', '宿主', '系统提示', '内部流程', '起报后的逐步预测')
    sources = {s['url'] for r in records if r.get('success') and isinstance(r.get('data'), dict)
               for s in r['data'].get('sources', []) if 'url' in s}
    for sentence in sentences(text):
        if any(w in sentence for w in words):
            issues.append({'sentence': sentence, 'reason': 'sensitive_or_internal_wording'})
            continue
        clean = re.sub(r'https?://[^\s<>）)]+', '', sentence)
        missing = [] if public_numeric_safe(clean, '') else ungrounded_numbers(clean, evidence)
        if missing:
            issues.append({'sentence': sentence, 'unsupported_numbers': missing})
            continue
        urls = re.findall(r'https?://[^\s<>）)]+', sentence)
        if any(u.rstrip('。；，') not in sources for u in urls):
            issues.append({'sentence': sentence, 'reason': 'unsupported_source_link'})
            continue
        # Never format digits in a verified link.
        parts = re.split(r'(https?://[^\s<>）)]+)', sentence)
        good.append(''.join(p if p.startswith(('https://', 'http://')) else number_text(unit_text(p)) for p in parts))
    return ''.join(good), issues


def argument_summary(args):
    labels = {'scope': '范围', 'date': '日期', 'relative_day': '相对日期', 'days': '天数',
              'floor': '楼层', 'elevator': '电梯', 'setpoint_c': '目标温度',
              'delta_c': '温度变化', 'query': '查询', 'city': '城市'}
    scopes = {'today_remaining': '今天剩余时段', 'next_day': '次日', 'future_24h': '未来24小时',
              'current': '当前', 'cumulative': '累计'}
    return '，'.join(labels.get(k, k) + '：' + scopes.get(str(v), str(v))[:100]
                    for k, v in args.items()) or '当前记录'
