"""Foreground single-process owned-port probe; batch <=5, each result persisted."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
for name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[name] = '1'
os.environ['LLM_MODE'] = 'real'


def source_hash():
    files = ['src/api/app.py', 'src/agent/agent_runner.py', 'src/agent/agent_provider.py',
             'src/agent/agent_tools.py', 'src/agent/agent_public.py',
             'src/agent/agent_validation.py', 'tests/building_chat_cases.json']
    files += ['src/agent/chat_tools.py', 'src/agent/chat_evidence.py', 'src/agent/chat_display.py',
              'src/agent/display_text.py', 'src/agent/orchestrator.py', 'src/agent/tools.py',
              'src/agent/topic_guard.py', 'src/agent/provider.py', 'src/agent/city_weather.py',
              'src/agent/web_search.py', 'src/data/replay_payload.py', 'configs/agent_tools.json']
    return {f: hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}


def cases_for(kind):
    if kind == 'ten':
        old = json.loads((ROOT/'experiments/native_agent_draft_20261013/latency_cases.json').read_text(encoding='utf-8'))
        return [{'question': c['question'], 'tool': (c.get('tools') or [None])[0],
                 'contains': c.get('contains', []), 'case_id': c['id']} for c in old]
    if kind == 'multi':
        return json.loads((HERE/'multi_cases.json').read_text(encoding='utf-8'))
    if kind == 'online':
        return [{'question': q, 'tool': None, 'contains': []} for q in [
            '今天下午哪个时段电费最贵？为什么？', '今天下午哪个时段电费最贵？为什么？',
            '未来24小时峰值是多少？', '储能电量多少？', '现在几点？']]
    if kind == 'guard':
        return [{'question': q, 'tool': None, 'contains': [], 'group': g, 'category': category}
                for q, g, category in [
                    ('联网查询中美关系最新新闻', 'politics', 'politics'),
                    ('现在几点？', 'politics', 'terminated'),
                    ('联网查询明星热搜丑闻', 'affairs', 'current_affairs'),
                    ('储能SOC多少？', 'affairs', 'terminated'),
                    ('现在天气怎么样？', 'weather', 'none')]]
    cases = json.loads((ROOT/'tests/building_chat_cases.json').read_text(encoding='utf-8'))
    # Both paths use the same revised display expectation; raw corpus stays intact.
    for case in cases:
        if case['question'] == '今天适合出去散步吗':
            case['contains'] = ['57.0%' if x == '57%' else x for x in case.get('contains', [])]
    return cases


def evaluate(case, answer, tools, done, steps, duration, trace=None):
    # Public events are presentation, not evidence. A direct route can query a
    # real tool without a tool_start; count only captured successful pipeline trace.
    tools=set(tools) | {t['tool'] for t in (trace or []) if t.get('tool') and isinstance(t.get('result'),dict)}
    if case.get('category') and case['category'] != 'none':
        return bool(done.get('terminated') and done.get('category') == case['category'] and
                    done.get('reason') == 'out_of_scope' and ('本会话已结束' in answer or
                    (case['category'] == 'terminated' and '会话已终止' in answer)) and
                    'web_search' not in tools and 'city_weather' not in tools)
    import re
    from experiments.agent_v3_20261013.semantic_assertions import no_local_identity
    known = done.get('known') or (case.get('allow_no_data') and no_local_identity(answer))
    valid = bool(known and done.get('grounded') and
                 (not case.get('tool') or case['tool'] in tools or
                  (case['tool'] in ('compare_costs', 'hvac_compare') and
                   bool({'compare_costs', 'hvac_compare'} & set(tools)))) and
                 all(s in answer for s in case.get('contains', [])) and
                 not any(s in answer for s in case.get('excludes', [])))
    if case.get('expected_exclusions'):
        from src.agent.chat_sentence_stream import exclusion_present
        valid &= all(exclusion_present(answer,e) for e in case['expected_exclusions'])
    if 'query_step_count' in case:
        valid &= steps.count('正在查询相关数据…') == case['query_step_count']
    if case.get('exact_sentences'):
        import re
        valid &= len([p for p in re.split(r'[。！？!?]', answer) if p.strip()]) == case['exact_sentences']
    if case.get('evidence_alert_count') and not case.get('semantic_check') == 'alerts_count':
        ops = json.loads((ROOT/f"exports/replay/{case.get('scenario', 'normal')}.ops.json").read_text(encoding='utf-8'))
        count = sum(e['offset_ms'] <= 14*3600000 for e in ops['alerts'])
        valid &= f'{count} 条告警记录' in answer
    if case.get('recent_news_14_days') and not case.get('semantic_check') == 'news':
        import re
        from datetime import datetime, timedelta, timezone
        if '最近两周没有查到相关报道' in answer:
            valid &= 'https://' not in answer and '最近两周查到的相关报道' not in answer
        else:
            dates = re.findall(r'(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)', answer)
            today = datetime.now(timezone.utc).date()
            valid &= bool(dates) and '最近两周查到的相关报道' in answer and '来源：' in answer and 'https://' in answer
            valid &= all(today-timedelta(days=14) <= datetime.fromisoformat(d).date() <= today for d in dates)
    return bool(valid)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=['ten', 'full', 'multi', 'online', 'guard'], default='full')
    parser.add_argument('--switch', choices=['on', 'off'], default='on')
    parser.add_argument('--run', default='acceptance')
    parser.add_argument('--case-file', help='Workspace-relative explicit regression subset; never changes the original corpus')
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--count', type=int, default=5)
    args = parser.parse_args()
    if not args.run.replace('-', '').isalnum() or not 1 <= args.count <= 5:
        raise SystemExit('invalid run/batch')
    os.environ['CHAT_AGENT_LOOP'] = '1' if args.switch == 'on' else '0'
    import httpx
    import uvicorn
    # Capture actual final pipeline traces equally on both switches, without
    # persisting prompts, credentials or inventing evidence from expected answers.
    pipeline_results = []
    from src.agent import chat_topic_hook
    original_guarded = chat_topic_hook.guarded_events
    def captured_guarded(*a, **kw):
        g = original_guarded(*a, **kw)
        while True:
            try:
                yield next(g)
            except StopIteration as end:
                pipeline_results.append(end.value or {})
                return end.value
    chat_topic_hook.guarded_events = captured_guarded
    from src.api.app import app
    from src.agent.agent_provider import AgentProvider
    # Only safe metrics, no messages or credentials captured.
    measured = []
    queried_records = []
    from src.agent import agent_runner
    original_run_tool = agent_runner.run_tool
    def tapped_tool(*a, **kw):
        result = original_run_tool(*a, **kw)
        queried_records.append(result)
        return result
    agent_runner.run_tool = tapped_tool
    original = AgentProvider.agent_stream
    def tapped(self, *a, **kw):
        before = len(self.metrics)
        try:
            yield from original(self, *a, **kw)
        finally:
            measured.extend(self.metrics[before:])
    AgentProvider.agent_stream = tapped
    from src.agent.provider import OpenAICompatibleProvider
    original_chat = OpenAICompatibleProvider.chat_call
    def measured_chat(self, *a, **kw):
        started = time.monotonic()
        result = original_chat(self, *a, **kw)
        measured.append({'phase': 'legacy_structured_' + str(a[0] if a else kw.get('phase')),
                         'status': result.get('llm', {}), 'total_ms': round((time.monotonic()-started)*1000,1)})
        return result
    OpenAICompatibleProvider.chat_call = measured_chat
    old_stream = OpenAICompatibleProvider.chat_stream
    def measured_old_stream(self, *a, **kw):
        started = time.monotonic()
        metric = {'phase': 'legacy_answer_stream', 'error': None, 'first_response_ms': None}
        try:
            for event in old_stream(self, *a, **kw):
                if event.get('type') == 'text_delta' and metric['first_response_ms'] is None:
                    metric['first_response_ms'] = round((time.monotonic()-started)*1000, 1)
                if event.get('type') == 'done':
                    metric['status'] = event.get('llm', {})
                yield event
        finally:
            metric['total_ms'] = round((time.monotonic()-started)*1000, 1)
            measured.append(metric)
    OpenAICompatibleProvider.chat_stream = measured_old_stream
    cases = json.loads((ROOT/args.case_file).read_text(encoding='utf-8')) if args.case_file else cases_for(args.kind)
    if args.kind == 'multi' and (args.start % 2 or args.count not in (2, 4)):
        raise SystemExit('multi groups must stay within a batch: use count 2 or 4 and even start')
    results_dir = HERE/'results'
    results_dir.mkdir(exist_ok=True)
    path = results_dir/f'{args.run}_{args.kind}_{args.switch}.json'
    hashes = source_hash()
    hashes.update({'probe.py': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   'multi_cases.json': hashlib.sha256((HERE/'multi_cases.json').read_bytes()).hexdigest(),
                   'src/agent/chat_progress.py': hashlib.sha256((ROOT/'src/agent/chat_progress.py').read_bytes()).hexdigest()})
    for f in ('src/agent/building_tools.py', 'src/agent/chat_router.py', 'src/agent/chat_sentence_stream.py',
              'src/agent/chat_topic_hook.py', 'src/agent/tariff_periods.py',
              'src/agent/storage_scope.py', 'src/agent/answer_filter.py',
              'src/agent/agent_prefetch.py', 'src/agent/agent_relevance.py',
              'experiments/agent_v3_20261013/semantic_assertions.py'):
        hashes[f] = hashlib.sha256((ROOT/f).read_bytes()).hexdigest()
    if args.case_file:
        hashes[args.case_file] = hashlib.sha256((ROOT/args.case_file).read_bytes()).hexdigest()
    freeze_name = args.run + '_freeze.json' if args.run in ('round3','round4') else 'round2_freeze.json'
    if args.run in ('round3','round4') or args.case_file == 'experiments/agent_v3_20261013/round2_cases.json':
        freeze = json.loads((HERE/freeze_name).read_text(encoding='utf-8'))
        for f, expected in freeze['hashes'].items():
            if hashlib.sha256((ROOT/f).read_bytes()).hexdigest() != expected:
                raise SystemExit('frozen input changed: ' + f)
        hashes['frozen_manifest'] = hashlib.sha256((HERE/freeze_name).read_bytes()).hexdigest()
    if args.run == 'repair5':
        freeze=json.loads((HERE/'repair5_freeze.json').read_text(encoding='utf-8'))
        for f,expected in freeze['hashes'].items():
            if hashlib.sha256((ROOT/f).read_bytes()).hexdigest()!=expected:
                raise SystemExit('frozen input changed: '+f)
        hashes['frozen_manifest']=hashlib.sha256((HERE/'repair5_freeze.json').read_bytes()).hexdigest()
    receipt = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {
        'kind': args.kind, 'switch': args.switch, 'source_hash': hashes, 'results': [],
        'model': AgentProvider().model, 'sessions': {}, 'complete': False,
        'single_python_process': True, 'resident_changed': False}
    if receipt['source_hash'] != hashes:
        raise SystemExit('source changed; use new run label')
    if len(receipt['results']) != args.start:
        raise SystemExit('confirmed case exists or previous batch missing')
    with tempfile.TemporaryDirectory(prefix='yunqi-v3-') as temp:
        os.environ['YUNQI_DB_PATH'] = str(Path(temp)/'takeover.db')
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
        config = uvicorn.Config(app, host='127.0.0.1', port=port, log_level='critical', access_log=False)
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True, name='owned-v3-backend')
        thread.start()
        try:
            for _ in range(150):
                if server.started:
                    break
                time.sleep(.02)
            else:
                raise RuntimeError('owned backend unavailable')
            with httpx.Client(timeout=32, trust_env=False) as client:
                for idx in range(args.start, min(args.start+args.count, len(cases))):
                    case = cases[idx]
                    scenario = case.get('scenario', 'normal')
                    data = json.loads((ROOT/f'exports/replay/{scenario}.json').read_text(encoding='utf-8'))
                    hour = case.get('origin_index', 14)
                    group = case.get('group') if args.kind in ('multi', 'guard') else None
                    session = receipt['sessions'].setdefault(group, {'id': uuid.uuid4().hex, 'history': [], 'context_id': None}) if group else {'id': uuid.uuid4().hex}
                    body = {'question': case['question'], 'scenario': scenario, 'origin': data['hours'][hour]['t'],
                            'display_date': '2026-10-13', 'display_time': case.get('display_time', f'{hour:02d}:00'),
                            'session_id': session['id'], 'history': session.get('history', []), 'context_id': session.get('context_id')}
                    before = len(measured)
                    record_start = len(queried_records)
                    pipeline_start = len(pipeline_results)
                    from datetime import datetime, timezone
                    request_started_utc = datetime.now(timezone.utc).isoformat()
                    started = time.monotonic()
                    events, error = [], None
                    first_answer = None
                    progress_receipts = []
                    try:
                        with client.stream('POST', f'http://127.0.0.1:{port}/chat/stream', json=body) as response:
                            response.raise_for_status()
                            for line in response.iter_lines():
                                if not line.startswith('data: '):
                                    continue
                                event = json.loads(line[6:]);events.append(event)
                                if event['type'] == 'progress':
                                    progress_receipts.append({**event, 'received_ms': round((time.monotonic()-started)*1000, 1)})
                                if event['type'] == 'answer_delta' and first_answer is None:
                                    first_answer = round((time.monotonic()-started)*1000, 1)
                    except Exception as exc:
                        error = type(exc).__name__
                    duration = round((time.monotonic()-started)*1000, 1)
                    answer = ''.join(e['text'] for e in events if e['type'] == 'answer_delta')
                    done = next((e for e in reversed(events) if e['type'] == 'done'), {})
                    tool_names = [e['tool'] for e in events if e['type'] == 'tool_start']
                    steps = [e.get('text', '') for e in events if e['type'] == 'step']
                    actual_records = queried_records[record_start:]
                    final_result = pipeline_results[-1] if len(pipeline_results) > pipeline_start else {}
                    valid = evaluate(case, answer, tool_names, done, steps, duration, final_result.get('tool_trace', [])) and error is None
                    from evidence_contract import records_from_trace, canonical_records
                    if args.switch == 'off':
                        actual_records = records_from_trace(final_result.get('tool_trace', []), data['hours'][hour]['t'])
                    else:
                        actual_records = canonical_records(actual_records, data['hours'][hour]['t'])
                    if group:
                        actual_records = session.get('scoring_records', []) + actual_records
                    scoring_error = None
                    if case.get('semantic_evidence'):
                        from semantic_assertions import check
                        try:
                            semantic_valid = check(case, answer, actual_records)
                            valid = valid and semantic_valid
                        except Exception as exc:
                            scoring_error = type(exc).__name__
                            valid = False
                    # Always persist a queried case before stopping on scorer defects.
                    receipt['results'].append({'index': idx, 'question': case['question'], 'answer': answer,
                        'tools': tool_names, 'duration_ms': duration, 'first_answer_ms': first_answer,
                        'correct_with_evidence': valid, 'scoring_error': scoring_error, 'success_within_15s': valid and duration <= 15000,
                        'finished_within_15s': duration <= 15000, 'done': done, 'error': error,
                        'upstream_calls': measured[before:], 'origin_index': hour, 'scenario': scenario,
                        'progress_receipts': progress_receipts, 'started_utc': request_started_utc,
                        'events': events if args.kind in ('guard', 'online') or args.case_file else None,
                        'original_index': case.get('original_index'),
                        'semantic_evidence': actual_records if case.get('semantic_evidence') else None,
                        'pipeline_captured': len(pipeline_results) > pipeline_start,
                        'final_trace': final_result.get('tool_trace', []),
                        'model_correct': valid and done.get('mode') == 'llm' and done.get('explanation_source') == 'llm',
                        'template_answer': done.get('explanation_source') == 'template',
                        'within_25s_with_answer': bool(answer and done and duration <= 25000),
                        'group': group})
                    if group:
                        session['history'] = (session['history'] + [{'role': 'user', 'content': case['question']},
                                             {'role': 'assistant', 'content': answer or '没有可用回答。'}])[-16:]
                        session['context_id'] = done.get('context_id')
                        session['scoring_records'] = actual_records
                    receipt['complete'] = len(receipt['results']) == len(cases)
                    path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps({'index': idx, 'correct': valid, 'duration_ms': duration, 'mode': done.get('mode'),
                                      'tools': tool_names}, ensure_ascii=False), flush=True)
                    if scoring_error:
                        raise RuntimeError('scoring failed after persisted case: ' + scoring_error)
        finally:
            # A pure-local response may finish before background classification.
            # Keep this owned test process alive until verdict/audit completes;
            # never orphan it into the next batch or delete its temporary DB early.
            classifiers = [t for t in threading.enumerate() if t.name == 'chat-topic-hook']
            for classifier in classifiers:
                classifier.join(timeout=21)
            receipt['background_classifiers_stopped'] = not any(t.is_alive() for t in classifiers)
            server.should_exit = True
            thread.join(timeout=5)
            receipt['owned_pid'] = os.getpid()
            receipt['owned_backend_stopped'] = not thread.is_alive()
            receipt['owned_ports'] = receipt.get('owned_ports', []) + [port]
            path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
            if not receipt.get('background_classifiers_stopped', True):
                raise RuntimeError('background classification shutdown pending')
            if thread.is_alive():
                raise RuntimeError('owned backend shutdown pending')


if __name__ == '__main__':
    main()
