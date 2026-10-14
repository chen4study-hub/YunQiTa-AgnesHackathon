import copy,json,re,subprocess
from pathlib import Path
import pytest
from src.agent.chat import answer
from src.agent.chat_engine import consume
from src.agent.chat_tools import execute
from src.agent.chat_evidence import compact_evidence,required_items
from src.agent.chat_sentence_stream import safe_sentence,host_supplement
from src.agent.display_text import display_evidence,operator_spacing,render_public_fields
from src.data.replay_payload import load_replay


def fixture():
    d=load_replay('normal');return d,d['hours'][14]


def test_hvac_lower_setpoint_uses_sourced_positive_added_cost(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d,row=fixture()
    r=answer('空调改24度电费多少',d,row);c=r['tool_trace'][-1]['result']
    assert c['savings_cny']<0 and c['extra_cost_cny']==-c['savings_cny']
    assert f"预计多花 {c['extra_cost_cny']:,.1f} 元" in r['answer']
    assert '费用差额' not in r['answer'] and '负值' not in r['answer'] and r['grounded']
    assert all(w in r['answer'] for w in ('可自动调度','未计入','只覆盖'))
    raw=consume(execute('hvac_compare','空调改24度电费多少',d,row,24))
    evidence=display_evidence(compact_evidence(raw['tool_trace']),row['t'],row)
    items=required_items(raw)
    assert any(i['field']=='extra_cost_cny' for i in items) and not any(i['field']=='savings_cny' for i in items)
    assert safe_sentence(f"预计多花 {c['extra_cost_cny']} 元。",'hvac_compare',raw,row,evidence)
    assert not safe_sentence(f"预计多花 {c['extra_cost_cny']+1} 元。",'hvac_compare',raw,row,evidence)
    assert not safe_sentence(f"预计费用差额 {c['savings_cny']} 元。",'hvac_compare',raw,row,evidence)
    item=next(i for i in items if i['field']=='extra_cost_cny')
    assert '预计多花' in host_supplement('hvac_compare',raw,[item],False,'已有说明。')


def test_hvac_lower_setpoint_reference_stream_still_grounded(monkeypatch):
    # 67e0900 checks provider config before composition; real mode without a key
    # is not online. Mock availability, never add deployment secrets.
    from src.agent import chat_engine
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Reference:
        def chat_stream(self,payload):
            yield dict(type='text_delta',text=payload['grounded_reference'])
            yield dict(type='done',llm=dict(reason='call_succeeded'))
    d,row=fixture();r=answer('空调改24度电费多少',d,row,Reference())
    assert '预计多花' in r['answer'] and r['grounded'] and r['explanation_source']=='llm'
    assert '费用差额' not in r['answer']


def test_handoff_plain_reason_no_internal_scores_prompt(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setattr('src.agent.takeover.lookup',lambda *a:None)
    d=load_replay('abstain');r=answer('为什么转人工',d,d['hours'][14])
    assert r['known'] and r['needs_human'] and '交值班人员处理' in r['answer']
    assert all(w not in r['answer'] for w in ('风险评分','阈值','门控','需人工复核'))
    compact=compact_evidence(r['tool_trace'])[-1]['result']
    assert all(k not in compact for k in ('risk_score','risk_threshold','confidence'))
    assert 'risk_score' in r['tool_trace'][-1]['result'] # audit retained


def test_spacing_idempotent_no_numeric_or_source_changes():
    s='按负荷1,291.0 kW安排调度，后续17:00 预测；相对基准上界削峰160.3 kW。需人工复核。'
    r=render_public_fields(dict(explanation=s,source='llm',count=3))
    assert '1,291.0 kW 安排' in r['explanation'] and '后续 17:00' in r['explanation']
    assert '比常规运行的高峰低 160.3 kW' in r['explanation'] and '交值班人员处理' in r['explanation']
    assert r['source']=='llm' and r['count']==3 and render_public_fields(r)==r
    assert operator_spacing('设定25.5 °C，电量30%待机')=='设定 25.5 °C，电量 30% 待机'


def test_energy_last_day_wording_and_history_scope(monkeypatch):
    from src.agent.building_tools import execute_choice
    d,row=fixture()
    for choice,q in [(dict(tool='energy_totals',parameters={'days':3}),'这几天的总能耗如何'),(dict(tool='end_use',parameters={'days':3,'scope':'cumulative'}),'这几天空调用电量')]:
        r=execute_choice(choice,q,d,row,display_date='2026-10-12',display_time='19:30')
        assert r['known'] and '最近 3 天（截至今天 19:30）' in r['answer'] and '末日' not in r['answer']
    code=Path('src/agent/building_tools.py').read_text(encoding='utf-8');assert '末日' not in code


def test_birthday_two_sentence_prompt_explicit_not_false_keyword_failure():
    from src.agent.general_chat import events
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            assert '恰好两句' in payload['answer_style'] and '生日快乐' in payload['answer_style']
            return dict(result=dict(answer='生日快乐，愿你每天都开开心心。愿新一岁充满健康与好运。'),llm=dict(mode='real',reason='call_succeeded'))
    r=consume(events('帮我写两句生日祝福',Fake()))
    assert len([s for s in re.split('[。！？]',r['answer']) if s.strip()])==2 and '生日' in r['answer']


@pytest.mark.parametrize('scenario',['normal','peak','abstain'])
def test_offline_export_only_public_prose_sources_numbers_controls_identical(scenario):
    from src.data.replay_payload import hydrate_hour
    from scripts.refresh_live_display import without_prose,categories
    from scripts.refresh_round79_operator_text import clean_live
    main=json.loads(subprocess.check_output(['git','show',f'58c7142:exports/replay/{scenario}.json']))
    detail=json.loads(subprocess.check_output(['git','show',f'58c7142:exports/replay/{scenario}.agent-detail.json']))
    old=copy.deepcopy(main);old['hours']=[hydrate_hour(main,r,detail) for r in main['hours']]
    old['meta']={**detail['origin_metadata'],'agent_detail_file':main['meta']['agent_detail_file']}
    current=load_replay(scenario)
    assert without_prose(old)==without_prose(current)
    assert categories(old)==categories(current)
    assert current==clean_live(current)
    receipt=json.loads(Path('experiments/round79_wording_export.json').read_text(encoding='utf-8'))
    assert receipt['nonprose_unchanged'] and receipt['new_llm_calls']==receipt['new_dispatches']==0
    for r in current['hours']:
        text=r['agent']['explanation']
        assert not re.search(r'(?<=[\u4e00-\u9fff])\d|(?:kWh|kW|°C|%)(?=[\u4e00-\u9fff])',text)
        assert '相对基准上界削峰' not in text
        assert '需人工复核' not in text


def test_no_takeover_record_must_not_be_worded_as_not_handed_off(monkeypatch):
    monkeypatch.setattr('src.agent.takeover.lookup',lambda *a:None)
    d=load_replay('abstain');row=d['hours'][14]
    r=consume(execute('handoff_reason','为什么转人工',d,row))
    evidence=display_evidence(compact_evidence(r['tool_trace']),row['t'],row)
    assert not safe_sentence('当前无转人工，本小时交值班人员处理。','handoff_reason',r,row,evidence)
    assert safe_sentence('当前没有已提交的人工接管记录，本小时交值班人员处理。','handoff_reason',r,row,evidence)
