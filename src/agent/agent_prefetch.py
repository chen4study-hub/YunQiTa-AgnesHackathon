"""Host-only fast read planning; no provider calls or external requests."""
import json
import re
from .building_tools import fast_choices
from .chat_tools import (intent, local_current_load, local_current_energy,
                         local_weather_scope, peak_scope, relative_hvac_delta,
                         absolute_hvac_target)
from .agent_tools import CATEGORIES, BY_NAME


def plan(question):
    choices = []
    expanded = set()
    conceptual = bool(re.search(r'基础知识|知识点|常识|原理|科普|介绍|区别|笑话|故事|什么意思|是什么意思', question))
    if re.fullmatch(r'(?:现在|当前)是什么天气[？?。\s]*',question):conceptual=False
    from .city_weather import city_name
    public_weather = bool(city_name(question) and re.search(r'天气|气温|温度|台风', question))
    if re.fullmatch(r'(?:现在|当前)是什么天气[？?。\s]*',question):public_weather=False
    public_query = bool(re.search(r'联网|新闻|搜索|公开资料|来源链接|诺贝尔|物理学奖', question))
    if public_weather or public_query:
        expanded.add('internet')
    def add(name, args=None, query=None):
        if name in BY_NAME and name not in ('web_search', 'city_weather', 'more_tools'):
            choice = {'name': name, 'args': args or {}, 'question': query or question}
            if not any(c['name'] == name and c['args'] == choice['args'] for c in choices):
                choices.append(choice)
    for part in re.split(r'[，,；;。！？!?]|另外|以及|还有', question):
        if not part.strip():
            continue
        # Outdoor city data and conceptual questions must never inherit local reads.
        if (public_weather and re.search(r'天气|气温|温度|台风', part)) or conceptual:
            continue
        if re.search(r'联网|新闻|公开|搜索', part):
            continue
        if re.fullmatch(r'(?:现在|当前)是什么天气',part.strip()):
            add('get_weather',{'scope':'current'},'现在天气怎么样')
            continue
        fast = fast_choices(part)
        from .storage_scope import storage_scope
        storage = storage_scope(part)
        if storage:
            name = {'history': 'storage_history', 'soc': 'current_state', 'power': 'current_energy'}[storage]
            args = next((c['parameters'] for c in fast if c['tool'] == 'storage_history'), {}) if storage == 'history' else {}
            add(name, args, part)
            if storage == 'history' and '功率' in part:
                add('current_energy', {}, part)
            continue
        if re.search(r'运行概览|楼宇概况|总负荷|总用电功率', part) or local_current_load(part):
            fast = [{'tool': 'building_state', 'parameters': {}}]
        for choice in fast:
            args = dict(choice.get('parameters') or {})
            if choice['tool'] == 'elevator_state':
                lift = re.search(r'(?<![A-Za-z0-9])([LH]\d+)(?![A-Za-z0-9])', part, re.I)
                if lift:
                    args['elevator'] = lift[1].upper()
            add(choice['tool'], args, part)
        if fast:
            if re.search(r'储能.*功率', part) and fast[0]['tool'] == 'storage_history':
                add('current_energy', {}, part)
            continue
        name, target = intent(part)
        args = {}
        if re.search(r'(?:适合|要不要|能不能|可以).*?(?:散步|跑步|出去玩)', part):
            add('get_weather', {'scope': 'current'}, part)
            continue
        if local_current_energy(part):
            name = 'current_energy'
        if name == 'hvac_compare':
            delta = relative_hvac_delta(part)
            target = absolute_hvac_target(part)
            if delta is not None:
                args = {'delta_c': delta}
            elif target is not None:
                args = {'setpoint_c': target}
            else:
                continue
        elif re.search(r'预测|预报', part) and '负荷' in part and name != 'forecast_peak':
            name, args = 'get_forecast', {'scope': peak_scope(part)}
        elif name == 'forecast_peak':
            args = {'scope': peak_scope(part)}
        elif name == 'get_weather':
            if not local_weather_scope(part):
                continue
            args = {'scope': 'current' if not re.search(r'未来|明天|次日|接下来', part) else peak_scope(part)}
        add(name, args, part)
    for choice in choices:
        expanded.update(cat for cat, names in CATEGORIES.items() if choice['name'] in names)
    # Expand likely public tools without executing them before the guard approves.
    for pattern, category in [(r'告警|报警|工单', 'alerts'), (r'电梯', 'elevators'),
                              (r'电费|用电|电价|能耗|分项', 'energy'),
                              (r'楼层|\d+层|湿度|PM2|总负荷', 'building'),
                              (r'充电|放电|充放电', 'storage'), (r'回执|调度|接管|转人工', 'operations'),
                              (r'负荷.*预测|预测.*负荷', 'forecast')]:
        if re.search(pattern, question, re.I):
            expanded.add(category)
    # Schema validate before submitting threads; the model can supplement misses.
    from jsonschema import validate
    valid = []
    for choice in choices:
        try:
            validate(choice['args'], BY_NAME[choice['name']]['parameters'])
        except Exception:
            continue
        valid.append(choice)
    return valid[:3], expanded
