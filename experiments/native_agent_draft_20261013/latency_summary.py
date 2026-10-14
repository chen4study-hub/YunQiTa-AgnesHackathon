"""Summarize saved evidence only; never makes a provider call."""
import json
import math
from pathlib import Path
import statistics

HERE = Path(__file__).resolve().parent


def quantile(values, fraction):
    if not values: return None
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def summary(receipt):
    rows = receipt['results']
    calls = [c for r in rows for c in r['upstream_calls']]
    observed = [c for c in calls if c['first_response_ms'] is not None]
    over8 = [c for c in observed if c['first_response_ms'] > 8000]
    censored8 = [c for c in calls if c['first_response_ms'] is None and c['total_ms'] >= 8000]
    no_content_early = [c for c in calls if c['first_response_ms'] is None and c['total_ms'] < 8000]
    late_rows = [r for r in rows if r['elapsed_ms'] > 15000]
    late_cases = []
    for r in late_rows:
        first = r['upstream_calls'][0]
        later = r['upstream_calls'][1:]
        late_cases.append({'case': r['case_id'], 'elapsed_ms': r['elapsed_ms'],
                           'first_request_ms': first['total_ms'],
                           'first_request_token_ms': first['first_response_ms'],
                           'later_requests_ms': round(sum(c['total_ms'] for c in later), 1),
                           'tool_ms': round(sum(t['elapsed_ms'] for t in r['tool_runs']), 1),
                           'steps': len(r['upstream_calls'])})
    acknowledgement_rows = [r for r in rows if any(a.strip() for a in r['acknowledgements'])]
    return {'combination': receipt['combination'], 'completed': receipt['completed'],
            'questions': len(rows), 'automatic_success': sum(r['success'] for r in rows),
            'automatic_success_within_15s': sum(r['success_within_15s'] for r in rows),
            'all_completion_within_15s': sum(r['elapsed_ms'] <= 15000 for r in rows),
            'total_median_ms': statistics.median(r['elapsed_ms'] for r in rows),
            'total_p90_ms': quantile([r['elapsed_ms'] for r in rows], .9),
            'total_max_ms': max(r['elapsed_ms'] for r in rows),
            'first_request_first_response_median_ms': statistics.median(
                r['upstream_calls'][0]['first_response_ms'] for r in rows
                if r['upstream_calls'][0]['first_response_ms'] is not None),
            'first_request_full_median_ms': statistics.median(r['upstream_calls'][0]['total_ms'] for r in rows),
            'all_upstream_requests': len(calls), 'first_token_over8_observed': len(over8),
            'first_token_over8_observed_ratio_all_requests': len(over8) / len(calls),
            'no_token_by8_censored': len(censored8), 'no_content_early_finish': len(no_content_early),
            'missed_8s_window_count': len(over8) + len(censored8),
            'missed_8s_window_ratio_all_requests': (len(over8) + len(censored8)) / len(calls),
            'questions_with_any_8s_miss': sum(any(c['first_response_ms'] is not None and c['first_response_ms'] > 8000
                or c['first_response_ms'] is None and c['total_ms'] >= 8000 for c in r['upstream_calls']) for r in rows),
            'first_step_8s_miss_questions': sum(r['upstream_calls'][0]['first_response_ms'] is not None
                and r['upstream_calls'][0]['first_response_ms'] > 8000 or r['upstream_calls'][0]['first_response_ms'] is None
                and r['upstream_calls'][0]['total_ms'] >= 8000 for r in rows),
            'tool_elapsed_max_ms': max((t['elapsed_ms'] for r in rows for t in r['tool_runs']), default=0),
            'acknowledgement_questions': len(acknowledgement_rows), 'late_cases': late_cases}


def main():
    reports = [json.loads(p.read_text(encoding='utf-8'))
               for p in sorted((HERE / 'latency_results').glob('*.json'))]
    out = {'note': 'Automatic success is a screening check, NOT production semantic approval. '
            'Exact first-token over8 and censored no-token-by8 are reported separately.',
           'combinations': [summary(r) for r in reports]}
    (HERE / 'latency_summary.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    for s in out['combinations']:
        print(json.dumps(s, ensure_ascii=False), flush=True)


if __name__ == '__main__': main()
