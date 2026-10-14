"""Public query boundaries, independent of search providers and result ranking."""
import re


def weather_question(question):
    # A city name, an award or a sporting event alone never authorizes weather.
    return bool(re.search(r'天气|气温|温度|湿度|降雨|下雨|降雪|下雪|风速|风力|晴天|阴天', question))


def local_reading_question(question):
    from .chat_router import building_reading_question
    from .tariff_periods import period_question
    from .building_tools import fast_choices
    conceptual = bool(re.search(r'什么是|是什么意思|原理|科普|知识|区别|介绍', question))
    return building_reading_question(question) or (not conceptual and
            (period_question(question) or bool(fast_choices(question))))


def timely_public_question(question):
    if local_reading_question(question) or re.fullmatch(
            r'(?:那|那么|请问)?(?:现在|当前|今天|今日)?(?:是)?(?:几点|几号|日期|时间)(?:了|是多少)?[？?。\s]*', question):
        return False
    return bool(re.search(r'(?<!\d)(?:19|20)\d{2}(?!\d)|联网|搜索|新闻|最新|近期|最近|今年|去年|明年|本届|上届|今天|现在|当前', question))


def denies_search(text):
    """Blanket absence/delegation, not an evidence-based unannounced award."""
    return bool(re.search(
        r'(?:没(?:有)?|未|暂未|未能|暂时没有)(?:能)?(?:查到|找到|搜到|检索到)|'
        r'(?:暂无|没有|缺少)(?:相关)?(?:公开)?(?:资料|来源|检索结果)|'
        r'(?:请|需要|如果|若|你|您).*?(?:提供|自行|自己).*?(?:联网|检索|搜索|查询)|'
        r'(?:无法|不能|暂不能)(?:确认|核实)', text))


def source_reference(result):
    sources = result.get('sources') or []
    answer = result.get('answer') or ''
    if sources:
        snippets = [s.get('title', '公开资料') + '：' + s['snippet'].strip()
                    for s in sources if isinstance(s.get('snippet'), str) and s['snippet'].strip()]
        # An absent aggregate answer does not mean an absent search result.
        if not answer or denies_search(answer):
            answer = ('公开来源摘要：\n' + '\n'.join(snippets) if snippets else
                      '已取得以下公开来源，但其摘要没有提供可直接确认的答案。')
        answer += '\n来源：\n' + '\n'.join(s.get('title', '公开资料') + '：' + s['url'] for s in sources)
        return answer
    # No retrieved evidence authorizes no additional event-status claim.
    return '暂时没有查到相关公开资料。'


def search_public(question, seconds, cancel):
    """Keep all six official award categories without editing ranked search.

    The official API adapter already performs year/publication/name checks.
    Run it within the same 8s budget and gate as web_search. On failure, use
    the existing generic search with only the remaining time.
    """
    import queue
    import threading
    import time
    import httpx
    from . import web_search
    budget = min(8., max(.01, seconds))
    deadline = time.monotonic() + budget
    year = re.search(r'(?<!\d)(?:19|20)\d{2}(?!\d)', question)
    if not (year and web_search.nobel_request(question)):
        return web_search.search(question, seconds=budget, cancel=cancel)
    if cancel.is_set():
        return {'status': 'unavailable', 'sources': []}
    if not web_search.SLOTS.acquire(blocking=False):
        return {'status': 'unavailable', 'sources': []}
    box = queue.Queue()
    stopped = threading.Event()
    bound = min(deadline, time.monotonic() + 3.)
    def official():
        try:
            left = max(.01, bound - time.monotonic())
            with httpx.Client(timeout=httpx.Timeout(left, connect=min(2., left)),
                              follow_redirects=False, trust_env=False) as client:
                client._lookup_cancel = stopped
                client._lookup_deadline = bound
                value = web_search.lookup(question, client) if not stopped.is_set() else None
                box.put(value)
        except Exception:
            box.put(None)
        finally:
            web_search.SLOTS.release()
    worker = threading.Thread(target=official, name='agent-official-nobel', daemon=True)
    worker.start()
    value = None
    try:
        while not cancel.is_set() and time.monotonic() < bound:
            try:
                value = box.get(timeout=min(.05, max(.001, bound-time.monotonic())))
                break
            except queue.Empty:
                continue
    finally:
        stopped.set()
        worker.join(timeout=min(.25, max(0., deadline-time.monotonic())))
    if value and value.get('sources'):
        # Official endpoint returns at most one source per award category.
        value = {**value, 'sources': value['sources'][:6], 'source_limit': 6,
                 'engines': [{'name': 'nobel', 'status': value.get('status')}],
                 'searched_at': web_search.utc_now().isoformat()}
        return value
    left = deadline-time.monotonic()
    if left <= .01 or cancel.is_set():
        return value or {'status': 'unavailable', 'sources': []}
    return web_search.search(question, seconds=left, cancel=cancel)
