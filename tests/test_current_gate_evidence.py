"""Offline v3 exact paired controls/economics and source-count reproduction."""
import json,subprocess
from pathlib import Path
import pytest
from scripts.report_agent13 import summarize
from src.agent.tools import check_constraints
from src.agent.orchestrator import candidate_evidence,ungrounded_numbers,rounded_tools
from tests.test_current_gate_distinct_metrics import metric_pair


def test_frozen_v3_current_gate_two_baselines_and_unchanged_control():
    rows=[json.loads(l) for l in Path('experiments/agent_eval_v3_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    old={(r['date'],r['hour']):r for r in [json.loads(l) for l in Path('experiments/agent_eval_v2_hours.jsonl').read_text(encoding='utf-8').splitlines()]}
    summary=json.loads(Path('experiments/agent_eval_v3_summary.json').read_text())
    assert len(rows)==len({(r['date'],r['hour']) for r in rows})==312
    for k,v in summarize(rows).items():assert summary['summary'][k]==v
    for r in rows:
        previous=old[r['date'],r['hour']];result=r['result']
        assert all(r[k]==previous[k] for k in ['forecast','context','constraints','economics','soc_before','soc_after'])
        assert result['plan']==previous['result']['plan']
        assert len({metric_pair(a) for a in result['candidates']})==len(result['candidates'])
        assert not check_constraints(result['plan'],r['constraints'])
        assert not ungrounded_numbers(result['reason'],{'forecast':rounded_tools(r['forecast']),'candidates':candidate_evidence(result['candidates'])})
        assert result['selected']==result['selection_reason']['preferred_candidate_id']
        if r['current_refused']:
            assert not r['provider_attempts'] and result['llm']['reason']=='refused_current'
            assert result['receipt']['count']==0 and result['plan'][0]['battery_kw']==0
        else:
            assert r['provider_attempts'] and result['receipt']['count']==2
            if any(x['abstain'] for x in r['forecast']['predictions'][1:]):
                assert '预测被拒绝，已保持设定且不充放电' in result['reason']
        for p,f in zip(result['plan'],r['forecast']['predictions']):
            if f['abstain']:assert p['battery_kw']==0
    assert summary['comparison_to_v2']['economic_changed_hours']==0
    assert summary['comparison_to_v2']['first_control_changed_hours']==0
    assert summary['summary']['accepted_current_provider_missed_hours']==0
    for d in summary['days']:
        current=summarize([r for r in rows if r['date']==d['date']])
        assert current['validated_real_llm_hours']+current['degraded_hours']+current['provider_bypass_hours']==24
        assert current['provider_bypass_hours']==current['current_refused_hours']
        assert all(d[k]==v for k,v in current.items())


def test_export_all_current_gates_distinct_metrics_and_same_powers():
    receipt=json.loads(subprocess.check_output(['git','show','c28a18e:experiments/agent_replay_export.json']).decode())
    assert receipt['current_gate_only'] and receipt['distinct_candidate_metric_precision_decimals']==1
    for name in ['normal','peak','abstain']:
        d=json.loads(subprocess.check_output(['git','show',f'c28a18e:exports/replay/{name}.json']).decode('utf-8'))
        old=json.loads(subprocess.check_output(['git','show',f'5cceccf:exports/replay/{name}.json']).decode())
        for r,p in zip(d['hours'],old['hours']):
            assert r['storage']==p['storage'] and r['grid_kw']==p['grid_kw']
            a=r['agent'];assert len({metric_pair(c) for c in a['candidates']})==len(a['candidates'])
            if r['abstain']:assert a['llm']['reason']=='refused_current' and a['receipt']['count']==0
            else:assert a['llm']['reason'] not in ('refused_current','refused_horizon') and a['receipt']['count']==2
        if name=='normal':
            assert len(d['hours'][0]['agent']['candidates'])==2
            assert d['hours'][0]['agent']['source']=='llm'
