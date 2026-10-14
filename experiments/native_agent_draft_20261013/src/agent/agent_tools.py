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
    item['parameters']['properties']['relative_day'] = {'type': 'integer', 'enum': [-1, -2]}
CATALOGUE += [
    entry('get_time', '时间与日期', '读取界面当前日期和时间；不要用模型记忆回答时钟。'),
    entry('get_weather', '本楼天气', '只查云栖塔室外当前或未来逐时温湿度，不代表其他城市。',
          {'scope': SCOPE}),
    entry('get_forecast', '负荷预测', '查询今天剩余、次日或未来24小时可用负荷预测。', {'scope': SCOPE}),
    entry('forecast_peak', '负荷峰值', '查询对应范围的负荷峰值及出现时间。', {'scope': SCOPE}),
    entry('selection_reason', '调度与候选', '读取冻结的当前调度、全部候选、控制值、电费及选择依据；不执行调度。'),
    entry('handoff_reason', '接管状态', '只读当前人工接管、接管人及原因；不能提交、取消或修改接管。'),
    entry('execution_receipt', '执行回执', '读取 BA/EMS 下发日志回执，指令条数及耗时。'),
    entry('current_state', '设备当前状态', '读取储能电量百分比、空调设定和室外温度。'),
    entry('current_energy', '当前能源', '读取光伏、电网和储能功率；储能正值为放电，负值为充电。'),
    entry('hvac_compare', '改温度对比', '比较改温度前后的费用和峰值，仅比较可自动调度时段，不改变设备。'
          '绝对目标用setpoint_c，相对升降用delta_c，两者只提供一个。',
          {'setpoint_c': {'type': 'number', 'minimum': 24, 'maximum': 27},
           'delta_c': {'type': 'number', 'minimum': -3, 'maximum': 3}}),
    entry('web_search', '联网查询', '查询公开知识、新近事实、新闻及来源链接；不替代本楼真实读数。',
          {'query': {'type': 'string', 'minLength': 1, 'maxLength': 1000}}, ['query']),
    entry('city_weather', '城市天气', 'Open-Meteo查询指定城市当前和次日天气，不是本楼读数。',
          {'city': {'type': 'string', 'minLength': 2, 'maxLength': 60}}, ['city']),
]
BY_NAME = {t['name']: t for t in CATALOGUE}
NATIVE_TOOLS = [{'type': 'function', 'function': {
    'name': t['name'], 'description': t['description'], 'parameters': t['parameters']}}
    for t in CATALOGUE]


def parse_call(call):
    name = call['name']
    if name not in BY_NAME:
        raise ValueError('unknown_tool')
    args = json.loads(call['arguments'])
    validate(args, BY_NAME[name]['parameters'])
    if name == 'hvac_compare' and len(args) != 1:
        raise ValueError('provide_one_temperature')
    return name, args


def run_tool(name, args, data, row, display_date, display_time, seconds, cancel):
    if name in ('web_search', 'city_weather'):
        from .web_search import search
        query = args['query'] if name == 'web_search' else args['city'] + '天气'
        result = search(query, seconds=min(8., seconds), cancel=cancel)
        return {'success': result.get('status') in ('ok', 'empty'), 'needs_human': False,
                'data': result, 'evidence': [], 'trace': [{'tool': name, 'result': result}]}
    if name in NAMES:
        r = execute_choice({'tool': name, 'parameters': args}, '', data, row, display_date, display_time)
    elif name == 'get_forecast':
        forecast = future_forecast(data, row, args.get('scope', 'future_24h'))
        r = {'known': True, 'needs_human': False,
             'tool_trace': [{'tool': name, 'result': forecast}]}
    else:
        # Scope is supplied by function arguments, not inferred from user keywords.
        scope = args.get('scope', 'future_24h')
        question = {'today_remaining': '今天剩余', 'next_day': '明天', 'future_24h': '未来24小时'}[scope]
        if name == 'get_weather':
            question = '天气' if 'scope' not in args else '未来天气'
        elif name == 'hvac_compare':
            target = args.get('setpoint_c', float(row['agent']['hvac_setpoint_c']) + args.get('delta_c', 0))
            if not 24 <= target <= 27:
                raise ValueError('temperature_out_of_range')
            args = {'setpoint_c': target}
            question = '空调'
        r = consume(execute(name, question, data, row, args.get('setpoint_c'), display_date, display_time))
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
            'data': view, 'evidence': evidence, 'trace': trace}
