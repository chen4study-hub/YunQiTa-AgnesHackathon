"""Offline receipt summary: quality, latency and provider waits are separate axes."""
import collections
import hashlib
import json
import math
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent


def summarize(filename):
    path = HERE/'results'/filename
    receipt = json.loads(path.read_text(encoding='utf-8'))
    rows = receipt['results']
    durations = sorted(r['duration_ms'] for r in rows)
    errors = collections.Counter(c.get('error') for r in rows for c in r.get('upstream_calls', []) if c.get('error'))
    # Native waits have per-attempt metrics; legacy host cuts off before the
    # transport may publish a final status, so use its authoritative phase reason.
    native = receipt['switch'] == 'on'
    timeout_questions = []
    timeout_attempts = 0
    completion_deadlines = 0
    wrong_with_timeout = wrong_without_timeout = 0
    for row in rows:
        if native:
            timed = sum(c.get('error') == 'first_token_timeout' for c in row.get('upstream_calls', []))
            completed_late = sum(c.get('error') == 'agent_deadline' for c in row.get('upstream_calls', []))
        else:
            timed = sum('timeout' in str(p.get('reason', '')) for p in row['done'].get('phase_timings', []))
            completed_late = 0
        timeout_attempts += timed
        completion_deadlines += completed_late
        if timed or completed_late:
            timeout_questions.append(row['index'])
        if not row['correct_with_evidence']:
            if timed or completed_late:
                wrong_with_timeout += 1
            else:
                wrong_without_timeout += 1
    groups = collections.defaultdict(list)
    for row in rows:
        if row.get('group'):
            groups[row['group']].append(row)
    slowest = max(rows, key=lambda r: r['duration_ms'])
    return {
        'receipt': filename, 'receipt_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'complete': receipt['complete'], 'count': len(rows),
        'correct_regression': sum(r['correct_with_evidence'] for r in rows),
        'correct_model_regression': sum(r.get('model_correct', False) for r in rows),
        'template_answers': sum(r.get('template_answer', False) for r in rows),
        'median_seconds': statistics.median(durations)/1000,
        'p90_seconds_nearest_rank': durations[math.ceil(.9*len(rows))-1]/1000,
        'slowest': {'index': slowest['index'], 'question': slowest['question'], 'seconds': slowest['duration_ms']/1000},
        'empty_answers': sum(not r['answer'] for r in rows),
        'over_25_seconds': [r['index'] for r in rows if r['duration_ms'] > 25000],
        'within_25_with_answer': sum(r.get('within_25s_with_answer', False) for r in rows),
        'first_response_timeouts': timeout_attempts,
        'completion_deadlines': completion_deadlines,
        'provider_error_counts': dict(errors),
        'timeout_question_indices': timeout_questions,
        'wrong_regression_with_timeout': wrong_with_timeout,
        'wrong_regression_without_timeout': wrong_without_timeout,
        'both_turns_regression_groups': sum(len(g) == 2 and all(r['correct_with_evidence'] for r in g) for g in groups.values()),
        'both_turns_model_groups': sum(len(g) == 2 and all(r.get('model_correct', False) for r in g) for g in groups.values()),
        'batches': len(receipt['owned_ports']), 'last_owned_pid': receipt.get('owned_pid'),
        'last_backend_stopped': receipt['owned_backend_stopped'],
        'utc_first_request': rows[0].get('started_utc'), 'utc_last_request': rows[-1].get('started_utc'),
        'limitations': ['Classification transport timeout counts were not instrumented.',
                       'Legacy counts are observed host wait timeouts, not all provider/network timeouts.',
                       'Regression correctness is not a full semantic judge; model correctness excludes template mode.',
                       'Native completion deadline is a client budget cutoff, not proof of a provider server failure.']}


if __name__ == '__main__':
    summary = {f: summarize(f) for f in ('quality_full_on.json', 'quality_full_off.json', 'quality_multi_on.json')}
    (HERE/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
