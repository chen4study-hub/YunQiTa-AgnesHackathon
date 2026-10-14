"""Frozen-export HVAC routing, late-origin grounding and one read-step boundary."""
import copy
import json
import pytest
from fastapi.testclient import TestClient
from src.agent import chat_engine,chat_tools
from src.agent.chat import answer
from src.agent.chat_sentence_stream import safe_sentence
from src.agent.chat_evidence import compact_evidence
from src.agent.display_text import display_evidence
from src.data.replay_payload import load_replay,ensure_hour

QUESTIONS=['把空调调低一度会怎样','空调设定调到24度会多花多少钱']
CLOCKS={2:'02:45',10:'10:30',19:'19:30'}


class Reference:
    def chat_stream(self,payload):
        yield {'type':'text_delta','text':payload['grounded_reference']}
        yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}


def collect(g):
    events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:return events,end.value


@pytest.mark.parametrize('index',[2,10,19])
@pytest.mark.parametrize('question',QUESTIONS)
@pytest.mark.parametrize('real',[False,True])
def test_three_origins_two_inputs_same_comparison(monkeypatch,index,question,real):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real' if real else 'demo'})
    d=load_replay('normal');row=ensure_hour(d,d['hours'][index]);provider=Reference() if real else None
    ev,r=collect(chat_engine.events(question,d,row,provider,display_time=CLOCKS[index]))
    c=r['tool_trace'][-1]['result'];target=24. if '24' in question else round(row['agent']['hvac_setpoint_c']-1,1)
    assert r['known'] and r['grounded'] and c['after_setpoint_c']==target
    assert c['setpoint_delta_c']==round(target-row['agent']['hvac_setpoint_c'],1)
    assert c['extra_cost_cny']>0 and c['peak_increase_kw']>0
    assert '预计多花' in r['answer'] and '电网峰值' in r['answer']
    assert f'{target:.1f} °C' in r['answer'] and '查不到' not in r['answer']
    assert '不会自动增加费用' not in r['answer']
    # 72f8c2b removed generic query narration; actual tool boundary is first.
    assert not any(e['type']=='step' for e in ev)
    assert ev[0]['type']=='tool_start' and ev[0]['tool']=='get_forecast'
    assert ''.join(e['text'] for e in ev if e['type']=='answer_delta')==r['answer']
    assert not any(e['type']=='error' for e in ev)
    if index==19:assert '次日 08:00–09:00、13:00–19:00' in r['answer']


@pytest.mark.parametrize('index',[2,10,19])
def test_absolute_target_equals_relative_delta_from_actual_setpoint(monkeypatch,index):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');row=ensure_hour(d,d['hours'][index])
    delta=round(row['agent']['hvac_setpoint_c']-24.,1)
    a=answer(QUESTIONS[1],d,row)['tool_trace'][-1]['result']
    b=answer(f'空调调低{delta}度会怎样',d,row)['tool_trace'][-1]['result']
    assert a==b


@pytest.mark.parametrize('tomorrow_available',[False,True])
def test_zero_today_explicit_absence_or_same_target_next_day_not_fake_zero(monkeypatch,tomorrow_available):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class NoComposition:
        def chat_stream(self,*a):pytest.fail('absence/fallback is sourced host answer')
    d=load_replay('normal');row=copy.deepcopy(ensure_hour(d,d['hours'][19]))
    for p in row['forecast_24h']:
        p['abstain']=not (tomorrow_available and p['t'][:10]!=row['t'][:10])
    for q in QUESTIONS:
        ev,r=collect(chat_engine.events(q,d,row,NoComposition()))
        c=r['tool_trace'][-1]['result']
        assert r['known'] and r['grounded'] and c['today_accepted_hours']==0
        assert '今天剩下的时段没有可自动调度的小时' in r['answer']
        assert '算不出' in r['answer'] and '查不到' not in r['answer']
        if tomorrow_available:
            assert c['extra_cost_cny']>0 and '次日同一设定' in r['answer'] and '不代表完整全天' in r['answer']
            for t in r['tool_trace']:
                if t['tool'].startswith('simulate_schedule'):
                    assert all(h['timestamp'][:10]!=row['t'][:10] for h in t['result']['hours'])
        else:
            assert c['before_cost'] is None and c['extra_cost_cny'] is None
            assert r['needs_human'] and '交值班人员处理' in r['answer']
            assert not any(t['tool'].startswith('simulate_schedule') for t in r['tool_trace'])
            assert '0.0 元' not in r['answer']
        # 72f8c2b: no generic query step, including refusal paths.
        assert not any(e['type']=='step' for e in ev)


@pytest.mark.parametrize('index',[2,10,19])
@pytest.mark.parametrize('question',QUESTIONS)
def test_json_sse_parity_and_once_query_step(monkeypatch,index,question):
    from src.api import app as api
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');row=d['hours'][index]
    monkeypatch.setattr(api,'replay_hour',lambda *a:(d,row))
    body={'question':question,'origin':row['t'],'scenario':'normal','display_time':CLOCKS[index]}
    with TestClient(api.app) as client:
        out=client.post('/chat',json=body).json()
        response=client.post('/chat/stream',json=body)
    ev=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert out['known'] and out['grounded']
    assert out['answer']==''.join(e['text'] for e in ev if e['type']=='answer_delta')
    assert ev[-1]['known'] and ev[-1]['grounded'] and ev[-1]['reason']=='answered'
    # 72f8c2b: preserve parity while removing generic query narration.
    assert not any(e['type']=='step' for e in ev)


def test_invalid_llm_retry_and_supplement_do_not_announce_more_reads(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Wrong:
        def chat_call(self,phase,payload,feedback=''):
            return {'result':{'answer':'多花 999999.9 元。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    class Partial:
        def chat_stream(self,payload):
            yield {'type':'text_delta','text':'下调空调设定不会自动增加费用。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    d=load_replay('normal');row=d['hours'][19]
    for provider in (Wrong(),Partial()):
        ev,r=collect(chat_engine.events(QUESTIONS[1],d,row,provider))
        assert r['known'] and r['grounded'] and '预计多花' in r['answer']
        assert '不会自动增加费用' not in r['answer']
        # 72f8c2b: retries do not repeat generic query narration.
        assert not any(e['type']=='step' for e in ev)


def test_step_is_absent_without_local_read(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');row=d['hours'][19]
    for q in ('现在几点','给我讲个笑话'):
        ev,r=collect(chat_engine.events(q,d,row))
        assert not any(e['type']=='step' and e.get('text')=='正在查询相关数据…' for e in ev)
