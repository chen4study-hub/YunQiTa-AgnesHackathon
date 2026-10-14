import importlib.util
from pathlib import Path

PATH=Path(__file__).resolve().parents[1]/'latency_summary.py'
spec=importlib.util.spec_from_file_location('latency_summary_tested',PATH)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_exact_slow_tokens_separate_censored_and_empty_completion():
    calls=[{'first_response_ms':9000.,'total_ms':10000.},
           {'first_response_ms':None,'total_ms':8100.},
           {'first_response_ms':None,'total_ms':100.}]
    rows=[{'elapsed_ms':11000.,'success':True,'success_within_15s':True,
           'upstream_calls':calls,'tool_runs':[],'acknowledgements':[],'case_id':'x'}]
    out=mod.summary({'results':rows,'combination':'x','completed':True})
    assert out['first_token_over8_observed']==1
    assert out['no_token_by8_censored']==1
    assert out['no_content_early_finish']==1
    assert out['missed_8s_window_count']==2
    assert out['missed_8s_window_ratio_all_requests']==2/3


def test_saved_combinations_all_have_same_ten_questions():
    import json
    base=PATH.parent
    receipts=[json.loads(p.read_text(encoding='utf-8')) for p in (base/'latency_results').glob('*.json')]
    assert len(receipts)==11
    expected=[c['id'] for c in json.loads((base/'latency_cases.json').read_text(encoding='utf-8'))]
    for r in receipts:
        assert r['completed'] and [c['case_id'] for c in r['results']]==expected
        assert r['tool_count'] in (6,20)
        assert 'API_KEY' not in str(r) and 'Authorization' not in str(r)
