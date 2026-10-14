"""Shared question scope: cumulative energy is never an instantaneous SOC."""
import re


def resolve_followup(question, history):
    """Resolve only a short charge/discharge ellipsis from a prior user intent.

    Never reuse assistant numbers, and never override a new explicit time scope.
    The current tool is queried again at this request's clock.
    """
    match = re.fullmatch(r'\s*(?:那|那么|那再|再)?\s*(充电|放电)(?:量)?\s*(?:呢|多少|是多少|了多少)?[？?。!！\s]*', question)
    if not match:
        return question
    users = [t.get('content', '') for t in (history or []) if t.get('role') == 'user']
    if not users:
        return question
    previous = users[-1]
    # Support charge -> discharge -> charge without crossing an unrelated turn.
    while users and re.fullmatch(r'\s*(?:那|那么|那再|再)?\s*(?:充电|放电)(?:量)?\s*(?:呢|多少|是多少|了多少)?[？?。!！\s]*', previous):
        users.pop()
        previous = users[-1] if users else ''
    if storage_scope(previous) != 'history' or not re.search(r'今天|今日|一共|累计|充了|放了', previous):
        return question
    if re.search(r'昨天|昨日|前天|过去|最近|\d{4}-\d{2}-\d{2}|\d+\s*月', previous):
        return question
    return '今天储能累计' + match[1] + '量是多少？'


def storage_scope(question):
    if not re.search(r'储能|电池|SOC|充电|放电|充放电', question, re.I):
        return None
    if re.search(r'原理|意思|是什么|介绍', question):
        return None
    # Energy totals/records outrank current wording, including 截至现在累计.
    if re.search(r'累计|一共|总共|记录|历史|昨天|昨日|前天|过去|最近|截至', question) or (
        re.search(r'今天|今日', question) and re.search(r'充电|放电|充放电', question)):
        return 'history'
    if re.search(r'充电量|放电量|充了.*电|放了.*电', question) and not re.search(r'现在|当前|此刻', question):
        return 'history'
    if re.search(r'功率|现在.*(?:充电|放电)|当前.*(?:充电|放电)', question):
        return 'power'
    if re.search(r'SOC|剩|电量|还能用多少电', question, re.I):
        return 'soc'
    return None
