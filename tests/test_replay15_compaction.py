"""Raw 1.5 contract, precision, roundtrip, lazy chat and offline wording checks."""
import copy,gzip,hashlib,json,subprocess
from pathlib import Path
from datetime import datetime
import pytest
from jsonschema import Draft202012Validator
from src.data.replay_payload import (load_replay,load_detail,hydrate_hour,ensure_hour,
    split_payload,display_precision,DERIVED_FORECAST)
from src.agent.chat_tools import execute
from src.agent.chat_engine import consume
from src.agent.display_text import compact_time_text,wording_text
from scripts.compact_replay import encode,validate_pair
from scripts.refresh_compact_prose import repair_known_paragraphs
from scripts.refresh_live_display import categories


@pytest.mark.parametrize('scenario',['normal','peak','abstain'])
def test_raw_main_detail_precision_size_and_exact_runtime_roundtrip(scenario):
    main=load_replay(scenario,hydrate=False);detail=load_detail(main);full=load_replay(scenario)
    assert main['schema_version']=='1.5'
    assert len(encode(main))<700_000
    assert display_precision(main)==main
    validate_pair(main,detail,full)
    for i,(row,restored) in enumerate(zip(main['hours'],full['hours'])):
        assert row['agent']['detail_index']==i and detail['hours'][str(i)]['t']==row['t']
        assert not set(('candidates','plan','simulation','selection_reason','llm','tool_trace','work_orders')) & set(row['agent'])
        assert all(not set(DERIVED_FORECAST)&set(p) for p in row['forecast_24h'])
        assert restored['agent']['candidates'] and restored['agent']['selection_reason']
        for c in row['agent']['candidate_summaries']:
            original=next(x for x in restored['agent']['candidates'] if x['candidate_id']==c['candidate_id'])
            assert c['energy_cost_cny']==round(original['simulation']['estimated_cost'],1) if original['simulation']['estimated_cost'] is not None else c['energy_cost_cny'] is None
            assert c['point_grid_peak_kw']==round(original['simulation']['estimated_peak_kw'],1) if original['simulation']['estimated_peak_kw'] is not None else c['point_grid_peak_kw'] is None
            assert c['upper_grid_peak_kw']==round(original['objective_metrics']['upper_grid_peak_kw'],1) if original['objective_metrics']['upper_grid_peak_kw'] is not None else c['upper_grid_peak_kw'] is None
    again,new_detail=split_payload(full);new_detail['main_sha256']=detail['main_sha256']
    assert encode(again)==encode(main) and encode(new_detail)==encode(detail)
    assert categories(main)==categories(full)


def test_numeric_precision_ids_nulls_and_frozen_constants():
    data={'power_kw':123.456,'soc':.123456,'risk_score':.89123456,'hvac_setpoint_c':25.512,
        'grid_kwh':-1.2345,'energy_cost_cny':9999.987,'x':1.234,'count':2,'abstain':False,
        'missing':None,'meta':{'hvac_method':{'fraction':.0123456789}}}
    out=display_precision(data)
    assert out['power_kw']==123.5 and out['energy_cost_cny']==10000.
    assert out['soc']==.1235 and out['risk_score']==.8912 and out['hvac_setpoint_c']==25.5
    assert out['x']==1.2 and out['grid_kwh']==-1.2
    assert out['count']==2 and out['abstain'] is False and out['missing'] is None
    assert out['meta']==data['meta']


def test_lazy_hour_rejects_wrong_origin_hash_and_filename(tmp_path):
    main=load_replay('normal',hydrate=False);detail=load_detail(main)
    wrong=copy.deepcopy(detail);wrong['hours']['14']['t']=main['hours'][13]['t']
    with pytest.raises(ValueError,match='origin mismatch'):hydrate_hour(main,main['hours'][14],wrong)
    main['meta']['agent_detail_file']='../normal.agent-detail.json'
    with pytest.raises(ValueError,match='filename'):load_detail(main)
    main=load_replay('normal',hydrate=False)
    (tmp_path/'normal.json').write_bytes(encode(main)+b' ')
    (tmp_path/'normal.agent-detail.json').write_bytes(encode(detail))
    with pytest.raises(ValueError,match='hash mismatch'):load_detail(main,tmp_path)


@pytest.mark.parametrize('q,tool',[('为什么这样调度','selection_reason'),('执行回执是什么','execution_receipt'),('未来天气怎么样','get_weather'),('明天最高负荷','forecast_peak'),('空调改26度电费多少','hvac_compare')])
def test_tools_lazy_read_match_full_evidence(q,tool):
    compact=load_replay('normal',hydrate=False);full=load_replay('normal')
    a=consume(execute(tool,q,compact,compact['hours'][14],26 if tool=='hvac_compare' else None))
    b=consume(execute(tool,q,full,full['hours'][14],26 if tool=='hvac_compare' else None))
    assert a['known'] and a['grounded'] and a['answer']==b['answer']
    assert a['tool_trace']==b['tool_trace']


def test_one_version_legacy_retained_and_old_fields_optional():
    s=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    v=Draft202012Validator(s)
    sample=json.loads(Path('exports/replay/sample.json').read_text(encoding='utf-8'));v.validate(sample)
    legacy=json.loads(subprocess.check_output(['git','show','ad86110:exports/replay/normal.json']))
    Draft202012Validator(json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'))).validate(legacy)
    v.validate(legacy)
    assert not {'candidates','selection_reason','llm','plan','simulation'}&set(s['$defs']['hour']['properties']['agent']['required'])


def test_source_counts_and_daily_gate_changes_are_audited():
    receipt=json.loads(Path('experiments/round78_export.json').read_text(encoding='utf-8'))
    for scenario in ('normal','peak','abstain'):
        full=load_replay(scenario);main=load_replay(scenario,hydrate=False);audit=receipt['scenarios'][scenario]
        assert categories(full)==categories(main)==audit['source_counts_after']
        assert [i for i,h in enumerate(main['hours']) if h['abstain']]==audit['refusal_hours_after']
        old=json.loads(subprocess.check_output(['git','show',f'a5c8ae0:exports/replay/{scenario}.json']))
        for row,prev in zip(main['hours'],old['hours']):
            assert row['point_kw']==prev['point_kw']
            assert row['agent']['receipt']['count']==0
            assert row['agent']['status']==('handoff' if row['abstain'] else 'executed')
            assert [p['point_kw'] for p in row['forecast_24h']]==[p['point_kw'] for p in prev['forecast_24h']]


def test_clock_postprocessor_never_splits_lists_or_duplicates_day_labels():
    raw='次日 00:00、次日 02:00、次日 05:00、次日 06:00充电。'
    out=compact_time_text(raw)
    assert out=='次日 00:00、02:00、05:00–06:00 充电。'
    assert compact_time_text(out)==out
    assert '、。' not in wording_text('充电时段为次日 00:00、。次日 02:00。')
    assert '等比' not in wording_text('等比 0 小时舒适越界。')


def test_known_paragraphs_readable_grounded_idempotent():
    for scenario,index in [('normal',7),('peak',7),('peak',21)]:
        data=load_replay(scenario);text=data['hours'][index]['agent']['explanation']
        assert all(w not in text for w in ('、。次日','等比','区间上界峰值',';','模拟','估算','情景'))
        # Grouped thousands commas are allowed; prose ASCII separators are not.
        import re
        assert not re.search(r'(?<!\d),(?!\d)|;',text)
        assert all(sentence.count('次日')<=1 for sentence in text.split('。'))
        # Legacy hard-coded paragraphs refer to pre-temperature-planner evidence.
        from src.agent.display_text import render_public_fields
        assert render_public_fields(copy.deepcopy(data))==data
        if scenario=='peak' and index==21:assert '复核' in text
