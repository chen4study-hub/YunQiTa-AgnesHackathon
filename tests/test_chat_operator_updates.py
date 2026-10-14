from src.data.replay_payload import load_replay
"""Operator-facing chat regression coverage; no external provider required."""
import copy,json,time,threading
from pathlib import Path
import pytest
from src.agent import chat_engine,chat_sentence_stream
from src.agent.chat import answer
from src.agent.chat_tools import execute,intent
from src.agent.chat_evidence import required_items,compact_evidence
from src.agent.display_text import compact_time_text,display_evidence
from scripts.refresh_compact_prose import remove_llm_policy_sentences
from scripts.refresh_live_display import without_prose


def fixture():
    d=load_replay('normal')
    return d,copy.deepcopy(d['hours'][14])


def collect(g):
    events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:return events,end.value


class Reference:
    def chat_stream(self,payload):
        yield {'type':'text_delta','text':payload['grounded_reference']}
        yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}


def test_structured_provider_wait_also_emits_same_progress_type():
    class Slow:
        def chat_call(self,*args):
            time.sleep(1.1)
            return {'result':{'tool':'unknown'},'llm':{'reason':'call_succeeded'}}
    events,r=collect(chat_engine.bounded_events(Slow(),'select',{},'',2.))
    assert events==[{'type':'progress','id':'chat-answer-wait','text':'正在组织回答，已等待 1 秒','elapsed_seconds':1}]
    assert r['llm']['reason']=='call_succeeded'


def test_first_token_twelve_second_limit_progress_and_no_late_answer(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    released=threading.Event();closed=threading.Event()
    class Slow:
        def chat_stream(self,payload):
            try:
                released.wait(16)
                yield {'type':'text_delta','text':'不应输出的迟到答案。'}
            finally:closed.set()
    start=time.monotonic()
    try:events,r=collect(chat_engine.events('现在储能电量多少',d,row,Slow()))
    finally:released.set()
    assert closed.wait(2)
    elapsed=time.monotonic()-start
    progress=[e for e in events if e['type']=='progress']
    seconds=[e['elapsed_seconds'] for e in progress]
    # 84c1ed3: first-token deadline is 12s, retaining the same 1.5s scheduler
    # allowance, contiguous progress, cancellation and no late answer.
    assert seconds==list(range(1,seconds[-1]+1)) and seconds[-1] in (11,12)
    assert {e['id'] for e in progress}=={'chat-answer-wait'}
    assert all(e['text']==f"正在组织回答，已等待 {e['elapsed_seconds']} 秒" for e in progress)
    assert 12<=elapsed<13.5 and r['llm']['reason']=='chat_first_token_timeout'
    assert r['explanation_source']=='template' and r['known'] and '迟到' not in r['answer']


def test_hvac_only_missing_items_no_repeated_savings(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    base=chat_engine.consume(execute('hvac_compare','空调改26度电费多少',d,row,26))
    cost=base['tool_trace'][-1]['result'];savings=cost['savings_cny']
    class Partial:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':f'仅接受时段、非全天，预计可节省 {savings:.1f} 元。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('空调改26度电费多少',d,row,Partial())
    assert r['answer'].count(f'{savings:,.1f} 元')==1
    assert '补充：' not in r['answer'] and '改前电费' in r['answer']
    assert r['llm']['accepted_llm_sentences']==1


def test_captured_hvac_wording_covers_changed_setpoint_and_cost_drop():
    from src.agent.chat_sentence_stream import item_present
    text='仅比较接受时段、非全天，空调从25.5 °C改到26.0 °C，接受时段电费降263.4 元。'
    assert item_present({'field':'after_setpoint_c','value':26.},text)
    assert item_present({'field':'savings_cny','value':263.4},text)


def test_unique_values_do_not_need_fixed_operator_synonyms():
    from src.agent.chat_sentence_stream import missing_items
    items=[{'field':'after_cost','value':16506.2},{'field':'savings_cny','value':263.4}]
    assert missing_items(items,'接受时段电费为16,506.2 元，少付263.4 元。')==[]
    same=[{'field':'before_cost','value':100.},{'field':'after_cost','value':100.}]
    assert missing_items(same,'改前电费 100 元。')==[same[1]]


def test_receipt_only_missing_elapsed(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # Partial wording must match the deliberately nonzero receipt fixture.
    row['agent']['receipt'].update(count=2,elapsed_ms=1.4)
    class Partial:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':'BA/EMS下发日志回执记录 2 条指令。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('执行回执是什么',d,row,Partial())
    assert r['answer'].count('2 条指令')==1 and r['answer'].count('BA/EMS')==1
    assert '耗时 1.4 毫秒' in r['answer'] and '补充' not in r['answer']


def test_next_day_scope_not_split(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    r=answer('明天最高负荷',d,row,Reference())
    assert '明天 13:00' in r['answer'] and r['answer'].count('明天')==1
    assert '次日' not in r['answer'] and '不代表' not in r['answer']
    assert '不代表。' not in r['answer']
    assert compact_time_text('次日峰值，次日可用小时，不代表次日完整全天。').endswith('不代表次日完整全天。')


@pytest.mark.parametrize('q',['现在光伏多少','电网功率多少','储能功率多少','当前能源功率'])
def test_energy_route_and_reference(monkeypatch,q):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    assert intent(q)[0]=='current_energy'
    r=answer(q,d,row,Reference())
    assert r['known'] and r['grounded'] and r['explanation_source']=='llm'
    expected={
        '现在光伏多少':[f"光伏功率 {row['pv']['power_kw']:,.1f} kW"],
        '电网功率多少':[f"电网功率 {row['grid_kw']:,.1f} kW"],
        '储能功率多少':[f"储能功率 {row['storage']['power_kw']:,.1f} kW"],
        '当前能源功率':[f"光伏功率 {row['pv']['power_kw']:,.1f} kW",f"电网功率 {row['grid_kw']:,.1f} kW",f"储能功率 {row['storage']['power_kw']:,.1f} kW"]}[q]
    assert all(s in r['answer'] for s in expected)
    if len(expected)==1:assert r['answer'].count('kW')==1


def test_energy_missing_not_fabricated(monkeypatch):
    d,row=fixture();row['pv']={};row['storage']={};row['grid_kw']=None
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    r=answer('光伏和电网功率多少',d,row)
    assert not r['known'] and r['grounded'] and '0.0 kW' not in r['answer']


def test_offline_whole_sentence_deletion_keeps_sources():
    original={'source':'llm','explanation_source':'llm','explanation':'电费 100 元。峰值容差内，选择方案。微差不计。继续执行。',
        'candidates':[{'source':'rule','reason':'峰值容差内，选择方案。'}],'metrics':{'cost':100}}
    cleaned=remove_llm_policy_sentences(original)
    assert cleaned['explanation']=='电费 100 元。继续执行。'
    assert cleaned['candidates'][0]['reason']==original['candidates'][0]['reason']
    assert without_prose(original)==without_prose(cleaned)


def test_selection_prompt_omits_internal_policy_but_trace_keeps_it():
    d,row=fixture();r=chat_engine.consume(execute('selection_reason','为什么这样调度',d,row))
    assert 'policy' in r['tool_trace'][-1]['result']
    assert 'policy' not in compact_evidence(r['tool_trace'])[-1]['result']
    evidence=display_evidence(compact_evidence(r['tool_trace']),row['t'],row)
    counts={}
    safe=chat_sentence_stream.safe_sentence('遵循峰值容差，电费较低。','selection_reason',r,row,evidence,counts)
    assert not safe and counts=={'prose_repair_failed':1}


def test_selection_failure_diagnostics_and_valid_reference(monkeypatch):
    d,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Bad:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':'当前方案节省 999999.9 元。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=answer('为什么这样调度',d,row,Bad())
    assert r['llm']['reason']=='chat_grounding_failed' and r['llm']['validation_failures']
    assert '999999' not in r['answer'] and '补充：' not in r['answer']
    good=answer('为什么这样调度',d,row,Reference())
    assert good['explanation_source']=='llm' and good['llm']['validation_failures']=={}
