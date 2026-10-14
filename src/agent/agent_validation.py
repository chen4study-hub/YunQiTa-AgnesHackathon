"""Sentence-level safety: one model repair, then omit only invalid sentences."""
import re
from .display_text import BANNED_USER_WORDS, number_text, unit_text
from .orchestrator import ungrounded_numbers
from .general_chat import public_numeric_safe


def sentences(text):
    # Query '?' is part of a source URL, not the end of a sentence.
    urls = []
    def hold(match):
        urls.append(match[0])
        return f'\ufff0{len(urls)-1}\ufff1'
    protected = re.sub(r'https?://[^\s<>）)]+', hold, text)
    def restore(part):
        return re.sub(r'\ufff0(\d+)\ufff1', lambda m: urls[int(m[1])], part)
    return [restore(s) for s in re.split(r'(?<=[。！？!?\n])', protected) if s.strip()]


def public_prose(text):
    """Exact display aliases only; retain verified URLs and meaningful acronyms."""
    from .answer_filter import strip_thoughts
    text = strip_thoughts(text)
    from .agent_tools import BY_NAME
    aliases = {name: item['display_name'] for name, item in BY_NAME.items()}
    aliases.update({'rule_full': '全额调度', 'rule_conservative': '保守调度', 'rule_hold': '保持设定',
                    'SOC': '电量', 'soc_percent': '储能电量', 'actual_kw': '楼宇总负荷',
                    'grid_kw': '电网购电功率', 'pv_kw': '光伏功率', 'battery_kw': '储能功率',
                    'charge_kwh': '充电量', 'discharge_kwh': '放电量', 'elapsed_ms': '耗时',
                    'upper_grid_peak_kw': '负荷偏高时的电网峰值', 'energy_cost_cny': '电费'})
    parts = re.split(r'(https?://[^\s<>）)]+)', text)
    for i, part in enumerate(parts):
        if part.startswith(('https://', 'http://')):
            continue
        for name in sorted(aliases, key=len, reverse=True):
            part = re.sub(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'(?![A-Za-z0-9_])', aliases[name], part)
        parts[i] = part
    return ''.join(parts)


def output_issue(sentence):
    clean = re.sub(r'https?://[^\s<>）)]+', '', sentence)
    if re.search(r'[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|`[^`]+`|"(?:type|text)"\s*:', clean):
        return 'internal_identifier'
    if re.search(r'(?:我|我们)?(?:先|接下来|下一步)?(?:查一下|查询一下|查一查|查看一下|展开.*工具|查询.*之后|稍后.*(?:告诉|回答)|马上.*(?:查|查询))', clean):
        return 'transition_not_answer'
    return None


def validate_answer(text, records, question=''):
    issues, good = [], []
    evidence = [r['evidence'] for r in records if r.get('success') and r.get('evidence')]
    words = BANNED_USER_WORDS + ('演示', '容差', '门控', '区间上界', '宿主', '系统提示', '内部流程', '起报后的逐步预测')
    sources = {s['url'] for r in records if r.get('success') and isinstance(r.get('data'), dict)
               for s in r['data'].get('sources', []) if 'url' in s}
    for sentence in sentences(public_prose(text)):
        output_problem = output_issue(sentence)
        if output_problem:
            issues.append({'sentence': sentence, 'reason': output_problem})
            continue
        if any(w in sentence for w in words):
            issues.append({'sentence': sentence, 'reason': 'sensitive_or_internal_wording'})
            continue
        clean = re.sub(r'https?://[^\s<>）)]+', '', sentence)
        from .chat_router import building_reading_question
        public = not building_reading_question(question) or any(r.get('success') and isinstance(r.get('data'), dict)
                     and r['data'].get('sources') for r in records)
        from .answer_grounding import numeric_issues
        missing = [] if public and public_numeric_safe(clean, question) else numeric_issues(clean, records)
        if missing:
            issues.append({'sentence': sentence, 'unsupported_numbers': missing})
            continue
        urls = re.findall(r'https?://[^\s<>）)]+', sentence)
        if any(u.rstrip('。；，') not in sources for u in urls):
            issues.append({'sentence': sentence, 'reason': 'unsupported_source_link'})
            continue
        # Never format digits in a verified link.
        parts = re.split(r'(https?://[^\s<>）)]+)', sentence)
        good.append(''.join(p if p.startswith(('https://', 'http://')) else unit_text(p) for p in parts))
    answer = ''.join(good)
    from .answer_grounding import daily_issues
    from .answer_scope import two_sentences, sentence_count, typhoon_claim_issue
    issues.extend(daily_issues(answer, records))
    if two_sentences(question) and sentence_count(answer) != 2:
        issues.append({'reason': 'exactly_two_sentences_required'})
    if typhoon_claim_issue(answer, question):
        issues.append({'reason': 'typhoon_impact_not_supported'})
    if re.search(r'修正一次回答|修订说明|先前回答|"type"\s*:\s*"text"', answer):
        issues.append({'reason': 'non_answer_payload'})
    from .agent_relevance import is_news_question
    if is_news_question(question):
        news_sources = [s for r in records if r.get('success') and isinstance(r.get('data'), dict)
                        and r['data'].get('recent_news') for s in r['data'].get('sources', [])]
        if not news_sources:
            # Empty/unavailable news never inherits an unrelated weather reference.
            return '没查到相关报道。', issues
    news_records = [r for r in records if r.get('success') and isinstance(r.get('data'), dict) and r['data'].get('recent_news')]
    if news_records and not any(r['data'].get('sources') for r in news_records):
        if sources or re.search(r'查到.*(?:一条|相关报道：)|据.*(?:报道|消息)|发布.*(?:新闻|预警)', answer) or not re.search(r'(?:没有|未|没|未能|暂未).*查到.*相关.*(?:报道|新闻)', answer):
            issues.append({'reason': 'no_relevant_news_claim_required'})
    city_records = [r for r in records if r.get('success') and isinstance(r.get('data'), dict)
                    and any(t.get('tool') == 'city_weather' for t in r.get('trace', []))]
    if city_records and answer:
        city_sources = {s['url']: s for r in city_records for s in r.get('data', {}).get('sources', [])}
        missing_sources = [s for u, s in city_sources.items() if u not in answer]
        if missing_sources:
            answer += '\n来源：\n' + '\n'.join(s['title'] + '：' + s['url'] for s in missing_sources)
    trace_names = {t.get('tool') for r in records if r.get('success') for t in r.get('trace', [])}
    from .chat_tools import local_current_weather
    if re.search(r'现在几点|当前时间|今天几号|今天日期', question) and 'get_time' not in trace_names:
        issues.append({'reason': 'clock_tool_required'})
    if local_current_weather(question) and 'get_weather' not in trace_names:
        issues.append({'reason': 'current_weather_tool_required'})
    from .storage_scope import storage_scope
    storage = storage_scope(question)
    soc_query = storage == 'soc'
    if storage == 'history' and 'storage_history' not in trace_names:
        issues.append({'reason': 'storage_history_tool_required'})
    if soc_query and 'current_state' not in trace_names:
        issues.append({'reason': 'current_state_tool_required'})
    if re.search(r'回执|执行记录', question) and 'execution_receipt' not in trace_names:
        issues.append({'reason': 'actual_receipt_tool_required'})
    if re.search(r'总负荷|总用电功率', question) and 'building_state' not in trace_names:
        issues.append({'reason': 'total_building_load_tool_required'})
    if re.search(r'累计|用了多少电|用电量', question) and not re.search(r'原理|意思|是什么', question):
        if not trace_names & {'energy_totals', 'end_use', 'pv_generation', 'storage_history'}:
            issues.append({'reason': 'cumulative_energy_tool_required'})
    for record in records:
        if not record.get('success'):
            continue
        for item in record.get('trace', []):
            result, tool = item.get('result', {}), item.get('tool')
            if tool == 'execution_receipt' and re.search(r'回执|执行记录', question):
                from .chat_sentence_stream import item_present
                for field in ('count', 'elapsed_ms'):
                    if result.get(field) is not None and not item_present({'field': field, 'value': result[field]}, answer):
                        issues.append({'reason': 'actual_receipt_value_required', 'field': field})
                if 'BA/EMS' not in answer or '日志回执' not in answer:
                    issues.append({'reason': 'receipt_log_label_required'})
            if tool == 'building_state' and re.search(r'总负荷|总用电功率', question):
                expected = result.get('actual_kw')
                numbers = re.findall(r'(?:总负荷|总用电功率)\s*(?:为|是|约)?\s*([\d,.]+)\s*kW', answer)
                if expected is not None and (not numbers or any(abs(float(n.replace(',', ''))-expected)>.05 for n in numbers)):
                    issues.append({'reason': 'total_load_value_mismatch'})
            if tool == 'get_weather' and result.get('scope') == 'current':
                if re.search(r'未来|随后|接下来|预报', answer):
                    issues.append({'reason': 'current_weather_scope'})
            if tool == 'forecast_peak':
                clock = f"{result['hour']:02d}:{result['minute']:02d}"
                if result.get('day_label') == '次日' and not re.search(r'次日[^。！？\n]*' + re.escape(clock), answer):
                    issues.append({'reason': 'next_day_peak_label_required'})
                if result.get('abstain') and (not question or re.search(r'负荷|预测|峰值',question)) and not re.search(r'刚才.*时间.*(?:再说|重复)',question) and not re.search(r'把握不大|暂不自动执行|人工|值班', answer):
                    issues.append({'reason': 'peak_confidence_notice_required'})
            if tool == 'storage_history' and storage == 'history':
                fields = [('charge_kwh', '充电'), ('discharge_kwh', '放电')]
                for field, label in fields:
                    if label in question or '充放电' in question or (label == '充电' and '充了' in question) or (label == '放电' and '放了' in question):
                        value = result.get(field)
                        matches = re.findall(label + r'(?:量)?\s*(?:为|是|约)?\s*([\d,.]+)\s*kWh', answer)
                        if value is not None and not any(abs(float(n.replace(',', ''))-value) <= .051 for n in matches):
                            issues.append({'reason': 'cumulative_storage_value_required', 'field': field})
            if tool == 'current_state' and soc_query:
                value = result.get('soc_percent')
                if value is not None and not re.search(r'(?<![\d.])' + re.escape(f'{value:g}') + r'(?:\.0)?\s*%', answer.replace(',', '')):
                    issues.append({'reason': 'current_soc_required'})
            if tool in ('hvac_compare', 'compare_costs') and (not question or re.search(r'空调|电费|比较|排除',question)):
                from .chat_sentence_stream import exclusion_present
                for excluded in result.get('excluded', []):
                    if not exclusion_present(answer, excluded):
                        issues.append({'reason': 'excluded_time_or_reason_missing', 'required': excluded})
                if '不按整天' not in answer and not re.search(r'刚才.*(?:排除|未计入)',question):
                    issues.append({'reason': 'comparison_scope_required'})
    from .chat_display import reading_text
    return reading_text(answer), issues


def argument_summary(args):
    labels = {'scope': '范围', 'date': '日期', 'relative_day': '相对日期', 'days': '天数',
              'floor': '楼层', 'elevator': '电梯', 'setpoint_c': '目标温度',
              'delta_c': '温度变化', 'query': '查询', 'city': '城市'}
    scopes = {'today_remaining': '今天剩余时段', 'next_day': '次日', 'future_24h': '未来24小时',
              'current': '当前', 'cumulative': '累计'}
    return '，'.join(labels.get(k, k) + '：' + scopes.get(str(v), str(v))[:100]
                    for k, v in args.items()) or '当前记录'
