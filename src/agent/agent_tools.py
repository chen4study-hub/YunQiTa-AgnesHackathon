"""Read-only function catalogue and validated adapters; no model-selected writes."""
import copy
import json
from datetime import datetime
from jsonschema import validate
from .building_tools import CATALOG, NAMES, execute_choice
from .chat_tools import execute, future_forecast
from .chat_engine import consume
from .orchestrator import rounded_tools
from .display_text import display_evidence
from .chat_evidence import compact_evidence

EMPTY = {'type': 'object', 'properties': {}, 'additionalProperties': False}
SCOPE = {'type': 'string', 'enum': ['today_remaining', 'next_day', 'future_24h']}


def entry(name, label, description, properties=None, required=None):
    return {'name': name, 'display_name': label, 'description': description,
            'parameters': {'type': 'object', 'properties': properties or {},
                           'required': required or [], 'additionalProperties': False}}


CATALOGUE = copy.deepcopy(CATALOG)
for item in CATALOGUE:
    item['parameters'] = copy.deepcopy(item['parameters'])
    if item['name'] != 'tariff_periods':
        item['parameters']['properties']['relative_day'] = {'type': 'integer', 'enum': [-1, -2]}
    clarifications = {
        'energy_totals': '仅累计kWh和元，不返回此刻瞬时kW；问今天用了多少电/电费用此工具。',
        'end_use': '当前占比用scope=current，瞬时分项kW；累计电量用scope=cumulative、kWh。不要把今天累计份额说成当前功率占比。',
        'building_state': 'actual_kw是整栋当前总负荷（含光伏和储能供能部分），不是grid_kw电网购电功率。总负荷/总用电功率查此工具。',
        'storage_history': '累计充放电为charge_kwh/discharge_kwh；当前SOC直接current_state，当前充放电功率current_energy。',
        'pv_generation': '发了多少电/累计发电量用generation_kwh；当前发电功率是pv.power_kw。'}
    item['description'] += clarifications.get(item['name'], '')
CATALOGUE += [
    entry('get_time', '时间与日期', '读取界面当前日期和时间；不要用模型记忆回答时钟。'),
    entry('get_weather', '本楼天气', '只查云栖塔室外当前或未来逐时温湿度，不代表其他城市。',
          {'scope': {'type': 'string', 'enum': ['current', 'today_remaining', 'next_day', 'future_24h']}}),
    entry('get_forecast', '负荷预测', '查询今天剩余、次日或未来24小时可用负荷预测。', {'scope': SCOPE}),
    entry('forecast_peak', '负荷峰值', '查询对应范围的负荷峰值及出现时间。', {'scope': SCOPE}),
    entry('selection_reason', '调度与候选', '读取冻结的当前调度、全部候选、控制值、电费及选择依据；不执行调度。'),
    entry('handoff_reason', '接管状态', '只读当前人工接管、接管人及原因；不能提交、取消或修改接管。'),
    entry('execution_receipt', '执行回执', '问执行回执/回执是什么也必须查询实际当前记录，回答count条指令和elapsed_ms毫秒、BA/EMS下发日志回执，不只解释概念，不证明设备已执行。'),
    entry('current_state', '设备当前状态', '读取储能电量百分比、空调设定和室外温度。'),
    entry('current_energy', '当前能源', '仅瞬时功率kW：pv_kw光伏、grid_kw电网购电、battery_kw储能。grid_kw不是整栋总负荷，总负荷查building_state actual_kw；累计电量kWh查energy类别。储能正值放电，负值充电。'),
    entry('hvac_compare', '改温度对比', '比较改温度前后的费用和峰值，仅比较可自动调度时段，不改变设备。'
          '绝对目标用setpoint_c，相对升降用delta_c，两者只提供一个。',
          {'setpoint_c': {'type': 'number', 'minimum': 24, 'maximum': 27},
           'delta_c': {'type': 'number', 'minimum': -3, 'maximum': 3}}),
    entry('web_search', '联网查询', '查询公开知识、新近事实、新闻及来源链接；不替代本楼真实读数。',
          {'query': {'type': 'string', 'minLength': 1, 'maxLength': 1000}}, ['query']),
    entry('city_weather', '城市天气', 'Open-Meteo查询指定城市当前和次日天气，不是本楼读数。回答必须给sources中的来源名称和完整URL，不删除年份或改URL数字。',
          {'city': {'type': 'string', 'minLength': 2, 'maxLength': 60}}, ['city']),
]
COMMON = ('get_time', 'get_weather', 'current_energy', 'current_state', 'forecast_peak', 'hvac_compare', 'web_search')
CATEGORIES = {
    'alerts': ('alerts_orders',), 'elevators': ('elevator_state',),
    'energy': ('energy_totals', 'end_use', 'pv_generation', 'tariff_periods'),
    'internet': ('web_search', 'city_weather'), 'storage': ('storage_history',),
    'building': ('building_state', 'floor_state'),
    'operations': ('selection_reason', 'handoff_reason', 'execution_receipt'),
    'forecast': ('get_forecast',),
}
CATALOGUE.append(entry('more_tools', '更多查询工具',
    '展开对应类别只读工具：alerts告警工单；elevators电梯；energy累计能耗分项光伏；'
    'internet联网与城市天气；storage充放电历史；building楼宇楼层；operations调度接管回执；forecast负荷预测。'
    '当前SOC请直接current_state，不展开储能历史。展开后下一步才能调用新工具。',
    {'category': {'type': 'string', 'enum': list(CATEGORIES)}}, ['category']))
BY_NAME = {t['name']: t for t in CATALOGUE}
NATIVE_TOOLS = [{'type': 'function', 'function': {
    'name': t['name'], 'description': t['description'], 'parameters': t['parameters']}}
    for t in CATALOGUE]


def available_tools(expanded=()):
    names = set(COMMON) | {'more_tools'}
    for category in expanded:
        names.update(CATEGORIES[category])
    return [copy.deepcopy(t) for t in NATIVE_TOOLS if t['function']['name'] in names]


def parse_call(call):
    name = call['name']
    if name not in BY_NAME:
        raise ValueError('unknown_tool')
    args = json.loads(call['arguments'])
    validate(args, BY_NAME[name]['parameters'])
    if name == 'hvac_compare' and len(args) != 1:
        raise ValueError('provide_one_temperature')
    return name, args


def normalize_call(name, args, question):
    """Question scope outranks model scope, but never turns history into current data."""
    import re
    args = dict(args)
    future = bool(re.search(r'未来|接下来|随后|预报|明天|次日', question))
    from .storage_scope import storage_scope
    scope = storage_scope(question)
    if name in ('storage_history', 'current_state', 'current_energy'):
        if scope == 'history':
            # Discard SOC/power arguments; cumulative date arguments remain valid.
            return 'storage_history', {k: v for k, v in args.items() if k in ('date', 'relative_day', 'days')}
        if scope == 'soc':
            return 'current_state', {}
        if scope == 'power':
            return 'current_energy', {}
    if name == 'get_weather' and not future:
        args = {'scope': 'current'}
    return name, args


def public_reference(result):
    from .agent_public import source_reference
    return source_reference(result)


def forecast_reference(forecast, origin):
    from .chat_tools import relative_time
    from .chat_display import reading_text
    return reading_text(''.join(relative_time(p['timestamp'], origin) + f'，负荷 {p["point"]:,.1f} kW。'
                               for p in forecast['predictions'])) or '没有后续可用的负荷预测。'


def run_tool(name, args, data, row, display_date, display_time, seconds, cancel, question=''):
    if name == 'web_search':
        from .agent_public import local_reading_question
        if local_reading_question(question or args.get('query', '')):
            return {'success': False, 'needs_human': False, 'data': {}, 'evidence': [],
                    'trace': [], 'reference': '', 'error': 'local_readings_require_local_tools'}
    if name == 'city_weather':
        from .agent_public import weather_question
        if not weather_question(question):
            return {'success': False, 'needs_human': False, 'data': {}, 'evidence': [],
                    'trace': [], 'reference': '', 'error': 'weather_question_required'}
    if name == 'more_tools':
        return {'success': True, 'needs_human': False, 'data': {'category': args['category'],
                'available': list(CATEGORIES[args['category']])}, 'evidence': {}, 'trace': []}
    name, args = normalize_call(name, args, question)
    if name in ('web_search', 'city_weather'):
        from .agent_public import search_public
        from .city_weather import query as weather_query
        result = (weather_query(args['city'] + '天气', seconds=min(8., seconds), cancel=cancel)
                  if name == 'city_weather' else search_public(args['query'], seconds=min(8., seconds), cancel=cancel))
        if name == 'web_search':
            from .agent_relevance import filter_result
            result = filter_result(question or args['query'], result)
        return {'success': result.get('status') in ('ok', 'empty'), 'needs_human': False,
                'data': result, 'evidence': [], 'trace': [{'tool': name, 'result': result}],
                'reference': public_reference(result)}
    if name in NAMES:
        r = execute_choice({'tool': name, 'parameters': args}, question, data, row, display_date, display_time)
    elif name == 'get_forecast':
        forecast = future_forecast(data, row, args.get('scope', 'future_24h'))
        r = {'known': True, 'needs_human': False,
             'tool_trace': [{'tool': name, 'result': forecast}],
             'answer': forecast_reference(forecast, row['t'])}
    else:
        # Scope is supplied by function arguments, not inferred from user keywords.
        scope = args.get('scope', 'future_24h')
        original_question = question
        question = {'current': '当前', 'today_remaining': '今天剩余', 'next_day': '明天', 'future_24h': '未来24小时'}[scope]
        if name == 'get_weather':
            question = '天气' if args.get('scope', 'current') == 'current' else '未来天气'
        elif name in ('get_time', 'current_state', 'current_energy'):
            question = original_question or question
        elif name == 'hvac_compare':
            target = args.get('setpoint_c', float(row['agent']['hvac_setpoint_c']) + args.get('delta_c', 0))
            if not 24 <= target <= 27:
                raise ValueError('temperature_out_of_range')
            args = {'setpoint_c': target}
            question = '空调'
        r = consume(execute(name, question, data, row, args.get('setpoint_c'), display_date, display_time))
    if name == 'building_state' and ('总负荷' in question or '总用电功率' in question):
        r['answer'] = r.get('answer', '').replace('当前负荷', '当前楼宇总负荷', 1)
    trace = r['tool_trace']
    if name == 'selection_reason':
        trace = trace + [{'tool': 'frozen_schedule', 'result': {
            'selected': row['agent'].get('selected'), 'candidates': row['agent'].get('candidates', []),
            'hvac_setpoint_c': row['agent'].get('hvac_setpoint_c')}}]
    view = compact_evidence(trace) if name != 'get_forecast' else rounded_tools(trace)
    evidence = display_evidence(view, row['t'])
    for clock in evidence['timestamp_clocks']:
        evidence.setdefault('display_clocks', []).append(clock)
    # Include trusted clock components in model-visible data; timestamps remain canonical.
    for item in view:
        if isinstance(item.get('result'), dict):
            item['result'].setdefault('display_clock_values', evidence['timestamp_clocks'])
    # A trusted adapter may supply already-validated display fields, not model prose.
    from .display_text import numeric_tokens
    if r.get('answer'):
        evidence['display_values'] = [float(v) for v in numeric_tokens(r['answer'])]
    return {'success': bool(r['known']), 'needs_human': bool(r['needs_human']),
            'data': view, 'evidence': evidence, 'trace': trace,
            'reference': r.get('answer', '')}
