"""Nine operator-chat fixes: deterministic providers only, no credentials/network."""
import json,re,time
from pathlib import Path
import pytest
from src.agent import chat_engine
from src.agent.chat import answer
from src.agent.chat_tools import execute
from src.agent.chat_evidence import compact_evidence,required_items
from src.agent.chat_sentence_stream import safe_sentence
from src.agent.display_text import display_evidence,render_public_fields
from src.data.replay_payload import load_replay


def fixture():
    data=load_replay('normal');return data,data['hours'][14]


def collect(generator):
    events=[]
    while True:
        try:events.append(next(generator))
        except StopIteration as end:return events,end.value


@pytest.mark.parametrize('q',['现在几点','今天几号','天气怎么样','现在几点、天气怎么样'])
def test_direct_tools_never_touch_provider_or_status(monkeypatch,q):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:pytest.fail('no provider config lookup'))
    class Never:
        def chat_call(self,*args):pytest.fail('no provider call')
        def chat_stream(self,*args):pytest.fail('no provider stream')
    data,row=fixture();start=time.monotonic()
    events,result=collect(chat_engine.events(q,data,row,Never(),display_date='2026-10-12',display_time='13:44'))
    assert time.monotonic()-start<1
    assert result['known'] and not result['llm_called'] and result['explanation_source']=='template'
    assert not any(e['type']=='progress' for e in events)
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==result['answer']


@pytest.mark.parametrize('q,field,forbidden',[
    ('现在储能电量多少','soc_percent','空调'),('空调设定多少','hvac_setpoint_c','电量'),
    ('现在光伏多少','pv_kw','电网')])
def test_required_values_and_empty_stream_fallback_are_question_scoped(monkeypatch,q,field,forbidden):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Empty:
        def chat_stream(self,payload):
            assert [i['field'] for i in payload['required_answer_values']]==[field]
            yield {'type':'done','llm':{'reason':'call_succeeded'}}
    data,row=fixture();result=answer(q,data,row,Empty())
    assert result['known'] and forbidden not in result['answer']


def test_progress_shared_between_selection_and_stream(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Slow:
        def chat_call(self,*args):
            time.sleep(1.1)
            return {'result':{'tool':'current_state','setpoint_c':None},'llm':{'reason':'call_succeeded'}}
        def chat_stream(self,payload):
            time.sleep(2.1)
            yield {'type':'text_delta','text':payload['grounded_reference']}
            yield {'type':'done','llm':{'reason':'call_succeeded'}}
    data,row=fixture();events,result=collect(chat_engine.legacy_events('帮我看看电池余量',data,row,Slow()))
    progress=[e for e in events if e['type']=='progress']
    assert [e['elapsed_seconds'] for e in progress]==[1,2]
    assert all(set(e)=={'type','id','text','elapsed_seconds'} and e['id']=='chat-answer-wait' for e in progress)
    assert result['known'] and result['explanation_source']=='llm'


def test_progress_shared_between_structured_calls():
    class Slow:
        def chat_call(self,*args):
            time.sleep(1.1);return {'llm':{'reason':'call_succeeded'},'result':{}}
    clock=chat_engine.ProgressClock();events=[]
    for phase in ('select','answer'):
        current,_=collect(chat_engine.bounded_events(Slow(),phase,{},'',3,clock));events+=current
    assert [e['elapsed_seconds'] for e in events]==[1,2]


def test_selection_savings_and_peak_survive_repair_without_weakening_grounding(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Reference:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':payload['grounded_reference']}
            yield {'type':'done','llm':{'reason':'call_succeeded'}}
    data,row=fixture();result=answer('为什么这样调度',data,row,Reference())
    metrics=row['agent']['selection_reason']['metrics'][row['agent']['selected']]
    assert all(f"{metrics[k]:,.1f} {u}" in result['answer'] for k,u in [('upper_grid_peak_kw','kW'),('energy_cost_cny','元')])
    assert result['llm']['dropped_sentences']==0 and result['llm']['validation_failures']=={}
    base=chat_engine.consume(execute('selection_reason','为什么这样调度',data,row))
    evidence=display_evidence(compact_evidence(base['tool_trace']),row['t'],row)
    assert not safe_sentence('预计节省 15,172.3 元。','selection_reason',base,row,evidence)


def test_receipt_and_temperature_template_are_operator_wording(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    data,row=fixture();receipt=answer('执行回执是什么',data,row)['answer']
    assert ' BA/EMS 下发日志回执' in receipt and '不是实物' not in receipt
    result=answer('空调改26度电费多少',data,row);text=result['answer']
    assert all(w not in text for w in ('接受时段','门控阈值','非全天收益','需人工核对'))
    scope=result['tool_trace'][-1]['result']
    assert all(w in text for w in (f"{scope['accepted_hours']} 个小时",f"{scope['excluded_hours']} 个小时未计入",'表计和设备记录','不按整天计算'))


def test_offline_refresh_deduplicates_only_matching_metrics():
    original={'explanation':'保守调度方案上界峰值 100.0 kW、电费 200.0 元，两项均优于保持方案。选用电费较低的方案，上界峰值 100.0 kW，电费 200.0 元。今晚次日充电，全精度下比较。',
        'explanation_source':'llm','source':'llm','metrics':{'peak':100.,'cost':200.}}
    cleaned=render_public_fields(original)
    assert cleaned['explanation'].count('100.0 kW')==1
    assert all(w not in cleaned['explanation'] for w in ('上界峰值','今晚次日','全精度下'))
    assert cleaned['source']=='llm' and cleaned['explanation_source']=='llm' and cleaned['metrics']==original['metrics']
    assert render_public_fields(cleaned)==cleaned
    different=render_public_fields({'text':'峰值 90.0 kW，电费 200.0 元。选用电费较低的方案，上界峰值 100.0 kW，电费 200.0 元。'})
    assert '100.0 kW' in different['text']
    assert render_public_fields({'text':'现在光伏发电0.0 kW，费用200.0 元。'})['text']=='现在光伏发电 0.0 kW，费用 200.0 元。'


def test_frozen_pair_sources_and_audit():
    receipt=json.loads(Path('exports/chat_wording_audit.json').read_text(encoding='utf-8'))
    assert receipt['new_llm_calls']==receipt['new_dispatches']==0 and receipt['nonprose_unchanged']
    for name in ('normal','peak','abstain'):
        data=load_replay(name)
        assert receipt['source_counts'][name]['before']==receipt['source_counts'][name]['after']
        for row in data['hours']:
            assert not re.search('上界峰值|今晚次日|全精度下',row['agent']['explanation'])


def test_saved_operator_wording_removes_grid_upper_gate_and_duplicate_cost():
    from src.agent.display_text import wording_text
    text='区间上界电网峰值为 1,199.5 kW。通过门控的时段可执行，被门控拒绝的时段需复核。'
    clean=wording_text(text)
    assert '区间上界' not in clean and '门控' not in clean
    text='负荷偏高时的峰值 1,190.7 kW；费用 20,352.9 元为该窗口最低。选用电费较低的方案，负荷偏高时的峰值 1,190.7 kW，电费 20,352.9 元。'
    clean=wording_text(text);assert clean.count('1,190.7')==1 and clean.count('20,352.9')==1


def test_clock_receipt_spacing_and_plain_handoff():
    from src.agent.display_text import compact_time_text,wording_text
    assert compact_time_text('今天 14:00当前小时回执2条，耗时1.4毫秒。')=='14:00 当前小时回执 2 条，耗时 1.4 毫秒。'
    assert '门控' not in wording_text('当前预测未通过置信门控，转人工复核。')
