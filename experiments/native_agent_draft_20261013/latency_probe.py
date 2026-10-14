"""Serial, isolated full-factorial probe. No API imports or background processes.
Run from workspace: python experiments/native_agent_draft_20261013/latency_probe.py ...
"""
import argparse
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import types

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
for name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[name] = '1'
os.environ['LLM_MODE'] = 'real'

# Draft-first import namespace, existing read-only tool dependencies second.
PACKAGE = 'yunqi_draft_latency'
pkg = types.ModuleType(PACKAGE)
pkg.__path__ = [str(HERE / 'src/agent'), str(ROOT / 'src/agent')]
sys.modules[PACKAGE] = pkg
loop = importlib.import_module(PACKAGE + '.agent_loop')
tools_mod = importlib.import_module(PACKAGE + '.agent_tools')
validation = importlib.import_module(PACKAGE + '.agent_validation')
transport = importlib.import_module(PACKAGE + '.provider')
from src.data.replay_payload import load_replay
import httpx

CASES = json.loads((HERE / 'latency_cases.json').read_text(encoding='utf-8'))
COMMON = ('get_time', 'get_weather', 'current_energy', 'current_state', 'forecast_peak', 'hvac_compare')
SHORT = {
    'get_time': '界面当前日期时间。', 'get_weather': '本楼当前或逐时室外温湿度。',
    'get_forecast': '可用时段负荷预测。', 'forecast_peak': '指定范围负荷峰值及时间。',
    'selection_reason': '只读调度、候选、费用和依据。', 'handoff_reason': '只读人工接管状态。',
    'execution_receipt': 'BA/EMS下发日志回执。', 'current_state': '储能SOC、空调设定、室外温度。',
    'current_energy': '当前光伏、电网、储能功率；正放电负充电。',
    'hvac_compare': '只读费用比较；setpoint_c绝对目标或delta_c相对变化，二选一。',
    'web_search': '公开知识新闻及来源，非本楼读数。', 'city_weather': '指定城市天气。',
    'energy_totals': '累计用电和电费。', 'end_use': '分项功率电量占比。',
    'alerts_orders': '截至时刻告警和工单。', 'elevator_state': '电梯运行记录，不证明健康。',
    'floor_state': '指定楼层负荷与环境。', 'storage_history': '储能SOC、功率、充放电量。',
    'pv_generation': '光伏功率和累计发电量。', 'building_state': '楼宇当前负荷环境人数及设定。',
}


def catalogue(size, description):
    out = copy.deepcopy(tools_mod.NATIVE_TOOLS)
    if size == 'common':
        out = [t for t in out if t['function']['name'] in COMMON]
    if description == 'short':
        for t in out:
            t['function']['description'] = SHORT[t['function']['name']]
    return out


class MeasuredProvider:
    def __init__(self, request_limit):
        config = transport.OpenAICompatibleProvider()
        self.endpoint, self.model = config.endpoint, config.model
        self.request_limit = request_limit
        self.calls = []
        self.key, _ = transport.read_key()
        if transport.get_llm_status()['mode'] != 'real' or not self.key:
            raise RuntimeError('real provider configuration unavailable')

    def request(self, messages, tools, remaining):
        start = time.monotonic()
        seconds = min(self.request_limit, remaining)
        body = {'model': self.model, 'messages': messages, 'tools': tools,
                'tool_choice': 'auto', 'stream': True, 'temperature': 0, 'max_tokens': 1800}
        metric = {'step': len(self.calls) + 1, 'headers_ms': None, 'first_sse_ms': None,
                  'first_response_ms': None, 'total_ms': None, 'complete': False,
                  'tool_names': [], 'output_chars': 0, 'error': None,
                  'request_bytes': len(json.dumps(body, ensure_ascii=False).encode('utf-8')),
                  'request_sha256': hashlib.sha256(json.dumps(body, sort_keys=True,
                        ensure_ascii=False).encode('utf-8')).hexdigest(),
                  'tool_count': len(tools), 'request_limit_seconds': seconds}
        self.calls.append(metric)
        text, calls, complete = [], {}, False
        timer = None
        client = httpx.Client(timeout=httpx.Timeout(seconds, connect=min(2., seconds)))
        # Hard wall deadline closes only this synchronous request's local client.
        # Timer thread is joined in finally before the next operation starts.
        timer = threading.Timer(seconds, client.close)
        timer.daemon = True
        timer.start()
        try:
            with client.stream('POST', self.endpoint,
                    headers={'Authorization': 'Bearer ' + self.key}, json=body) as response:
                metric['headers_ms'] = round((time.monotonic() - start) * 1000, 1)
                response.raise_for_status()
                for line in response.iter_lines():
                    if time.monotonic() - start >= seconds:
                        raise TimeoutError()
                    if not line.startswith('data:'):
                        continue
                    if metric['first_sse_ms'] is None:
                        metric['first_sse_ms'] = round((time.monotonic() - start) * 1000, 1)
                    raw = line[5:].strip()
                    if raw == '[DONE]':
                        break
                    choices = json.loads(raw).get('choices') or []
                    if not choices:
                        continue
                    if len(choices) != 1:
                        raise ValueError()
                    choice = choices[0]
                    delta = choice.get('delta') or {}
                    if delta.get('refusal'):
                        raise ValueError()
                    content, fragments = delta.get('content') or '', delta.get('tool_calls') or []
                    if (content or fragments) and metric['first_response_ms'] is None:
                        metric['first_response_ms'] = round((time.monotonic() - start) * 1000, 1)
                    text.append(content)
                    metric['output_chars'] += len(content) + len(json.dumps(fragments))
                    if metric['output_chars'] > 32000:
                        raise ValueError()
                    for fragment in fragments:
                        index = fragment['index']
                        if not isinstance(index, int) or not 0 <= index < 8:
                            raise ValueError()
                        call = calls.setdefault(index, {'name': '', 'arguments': ''})
                        function = fragment.get('function', {})
                        call['name'] += function.get('name', '')
                        call['arguments'] += function.get('arguments', '')
                    finish = choice.get('finish_reason')
                    if finish in ('stop', 'tool_calls'):
                        complete = True
                    elif finish:
                        raise ValueError()
                if not complete:
                    raise ValueError()
            metric['complete'] = True
            metric['tool_names'] = [calls[i]['name'] for i in sorted(calls)]
            return transport.redact({'content': ''.join(text),
                                    'calls': [calls[i] for i in sorted(calls)]}, self.key)
        except Exception as exc:
            # Only safe class/status, no exception messages, URL, request or raw body.
            metric['error'] = type(exc).__name__
            if isinstance(exc, httpx.HTTPStatusError):
                metric['status'] = exc.response.status_code
            return None
        finally:
            timer.cancel()
            timer.join()
            client.close()
            metric['total_ms'] = round((time.monotonic() - start) * 1000, 1)

def run_case(case, selected, description, light, request_limit):
    available = catalogue(selected, description)
    allowed = {t['function']['name'] for t in available}
    provider = MeasuredProvider(request_limit)
    data = load_replay('normal')
    row = data['hours'][14]
    messages = [{'role': 'system', 'content': loop.SYSTEM},
                {'role': 'system', 'content': '当前查询时钟与数据起点：' + json.dumps({
                    'display_date': '2026-10-13', 'display_time': '14:00', 'origin': row['t']})},
                {'role': 'system', 'content': (
                    '需要工具时，在首步工具调用前先说一句不含数据的简短回应，然后查询并完成回答。'
                    if light else '需要工具时，首步直接查询，不给过渡回复；查询后完成回答。')},
                {'role': 'user', 'content': case['question']}]
    started = time.monotonic()
    deadline = started + 30.
    records, tool_runs, acknowledgements, final, issues = [], [], [], '', []
    retries, repair_used, failure = 0, False, 'agent_step_limit'
    cancel = threading.Event()
    for step in range(8):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failure = 'agent_deadline'
            break
        message = provider.request(messages, available, remaining)
        if message is None:
            failure = 'provider_failed'
            if retries < 1 and deadline - time.monotonic() > .2:
                retries += 1
                continue
            break
        calls = message.get('calls') or []
        if calls:
            if repair_used:
                failure = 'invalid_tool_batch_after_repair'
                break
            if message.get('content'):
                acknowledgements.append(message['content'])
            native_calls = [{'id': f'probe-{step}-{i}', 'type': 'function',
                             'function': call} for i, call in enumerate(calls)]
            messages.append({'role': 'assistant', 'content': message.get('content') or None,
                             'tool_calls': native_calls})
            for call, native in zip(calls, native_calls):
                tool_start = time.monotonic()
                metric = {'step': step + 1, 'tool': call['name'], 'success': False,
                          'elapsed_ms': None, 'error': None, 'arguments': None}
                tool_runs.append(metric)
                try:
                    if call['name'] not in allowed:
                        raise ValueError('not_exposed')
                    name, args = tools_mod.parse_call(call)
                    metric['arguments'] = args
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    r = tools_mod.run_tool(name, args, data, row, '2026-10-13', '14:00', remaining, cancel)
                    metric['success'] = bool(r.get('success'))
                    records.append(r)
                    value = {k: v for k, v in r.items() if k not in ('trace', 'evidence')}
                except Exception as exc:
                    metric['error'] = type(exc).__name__
                    value = {'success': False, 'error': 'invalid_tool_or_failed'}
                finally:
                    metric['elapsed_ms'] = round((time.monotonic() - tool_start) * 1000, 1)
                messages.append({'role': 'tool', 'tool_call_id': native['id'],
                                 'content': json.dumps(value, ensure_ascii=False)})
            continue
        text = message.get('content') or ''
        good, issues = validation.validate_answer(text, records)
        if issues and not repair_used and step < 7 and deadline - time.monotonic() > .2:
            repair_used = True
            messages.append({'role': 'assistant', 'content': text})
            messages.append({'role': 'user', 'content': '请重写一次最终回答；不要再查工具。以下句子未通过校验，'
                             '逐一修正或删除，保留其余正确内容，不用固定模板：' + json.dumps(issues, ensure_ascii=False)})
            continue
        final = good
        failure = None if good else 'answer_validation_failed'
        break
    elapsed = round((time.monotonic() - started) * 1000, 1)
    successful_tools = {t['tool'] for t in tool_runs if t['success']}
    reasons = []
    if failure:
        reasons.append(failure)
    if not final.strip():
        reasons.append('empty_answer')
    if issues:
        reasons.append('validation_omissions')
    if not set(case['tools']).issubset(successful_tools):
        reasons.append('missing_expected_tool')
    if any(s not in final for s in case['contains']):
        reasons.append('missing_required_content')
    if any(s in final for s in case.get('excludes', [])):
        reasons.append('forbidden_content')
    if case.get('sentences') and len(validation.sentences(final)) != case['sentences']:
        reasons.append('sentence_count')
    for name, expected in case.get('args', {}).items():
        if not any(t['success'] and t['tool'] == name and t['arguments'] == expected for t in tool_runs):
            reasons.append('wrong_arguments')
    return {'case_id': case['id'], 'question': case['question'], 'answer': final,
            'success': not reasons, 'success_within_15s': not reasons and elapsed <= 15000,
            'failure_reasons': reasons, 'elapsed_ms': elapsed, 'upstream_calls': provider.calls,
            'tool_runs': tool_runs, 'acknowledgements': acknowledgements, 'repair_used': repair_used,
            'validation_issues': issues, 'expected_tools': case['tools'], 'retry_count': retries}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tools', choices=['all', 'common'], required=True)
    parser.add_argument('--description', choices=['original', 'short'], required=True)
    parser.add_argument('--light', choices=['yes', 'no'], required=True)
    parser.add_argument('--request-limit', type=float, default=30.)
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--count', type=int, default=5)
    parser.add_argument('--run', default='factorial')
    args = parser.parse_args()
    if not 0 < args.request_limit <= 30:
        raise ValueError('request limit must exceed zero and not exceed 30')
    if not 0 <= args.start < len(CASES) or not 1 <= args.count <= 10:
        raise ValueError('invalid batch')
    tag = f'{args.run}_{args.tools}_{args.description}_light-{args.light}_cap-{args.request_limit:g}'
    if any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.' for c in tag):
        raise ValueError('invalid run tag')
    out = HERE / 'latency_results' / (tag + '.json')
    out.parent.mkdir(exist_ok=True)
    files = (HERE / 'latency_probe.py', HERE / 'latency_cases.json',
             HERE / 'src/agent/agent_tools.py', HERE / 'src/agent/agent_validation.py',
             ROOT / 'src/agent/building_tools.py', ROOT / 'exports/replay/normal.json')
    hashes = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    receipt = {'combination': tag, 'tools': args.tools, 'description': args.description,
               'light': args.light, 'total_budget_seconds': 30., 'request_limit_seconds': args.request_limit,
               'model': transport.OpenAICompatibleProvider().model,
               'tool_count': len(catalogue(args.tools, args.description)),
               'tool_json_bytes': len(json.dumps(catalogue(args.tools, args.description),
                                               ensure_ascii=False).encode('utf-8')),
               'source_sha256': hashes, 'completed': False, 'results': []}
    if out.exists():
        receipt = json.loads(out.read_text(encoding='utf-8'))
        if receipt['source_sha256'] != hashes:
            raise RuntimeError('source changed; use a new run tag')
    for case in CASES[args.start:args.start + args.count]:
        if any(r['case_id'] == case['id'] for r in receipt['results']):
            raise RuntimeError('confirmed case exists; use next batch or new run tag')
        result = run_case(case, args.tools, args.description, args.light == 'yes', args.request_limit)
        receipt['results'].append(result)
        receipt['completed'] = len(receipt['results']) == len(CASES)
        out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'combination': tag, 'case': result['case_id'], 'success': result['success'],
                          'within_15s': result['success_within_15s'], 'elapsed_ms': result['elapsed_ms'],
                          'steps': len(result['upstream_calls']), 'failure': result['failure_reasons'],
                          'first_response_ms': [c['first_response_ms'] for c in result['upstream_calls']],
                          'upstream_ms': [c['total_ms'] for c in result['upstream_calls']]},
                         ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
