from src.data.replay_payload import load_replay
"""Allowed numbers are prompt data, not a validation bypass; comparisons exclude refusal."""
import copy
import json
import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_tools,chat_engine,orchestrator,provider
from src.agent.chat import answer
from src.agent.numeric_prompt import allowed_numbers,numeric_instruction,MARKER
from src.agent.tools import tool_config
from scripts.regress_grounding_prompt import summarize


def fixture():
    data=load_replay('normal');row=data['hours'][14]
    for p in row['forecast_24h']:
        p['abstain']=False;p['point_kw']=1000.
    row['agent']['hvac_setpoint_c']=25.5
    return data,row


def test_number_list_semantic_one_decimal_no_bool_strings_or_conversion():
    evidence={'forecast':{'upper':1234.567,'confidence':.923,'abstain':True,'timestamp':'2017-10-23T14:00:00-05:00'},
        'candidates':[{'battery_kw':-100.,'soc':.5,'objective_metrics':{'energy_cost_cny':42.76}}]}
    rows=allowed_numbers(orchestrator.rounded_tools(evidence));text=numeric_instruction(orchestrator.rounded_tools(evidence))
    assert all(len(r['value'].split('.')[1])==1 and r['sources'] and r['meaning'] for r in rows)
    assert '1234.6 | 预测区间上界(kW)' in text and '-100.0 | 储能功率' in text
    assert '0.9 | 置信度(比例)' in text and '0.5 | SOC(比例)' in text
    assert '2017' not in text and '50.0' not in text and 'True' not in text
    assert not orchestrator.check_grounding('置信度92.3%',evidence)
    assert not orchestrator.check_grounding('费用42.8元',evidence)  # validation still needs rounded evidence, not prompt
    assert orchestrator.check_grounding('费用42.8元',orchestrator.rounded_tools(evidence))


def test_agent_each_retry_includes_number_meanings_not_new_control(tmp_path):
    data,row=fixture();forecast=chat_tools.future_forecast(data,row);context=chat_tools.future_context(row)
    class Retry:
        calls=0
        def choose_candidate(self,forecast,candidates,instruction):
            self.calls+=1
            assert MARKER in instruction and '预测区间上界(kW)' in instruction and '电费(元)' in instruction
            c=next(c for c in candidates if c['selection_reason']['objective_optimal'])
            reason='收益999999.9元' if self.calls==1 else f"按上界{max(p['upper'] for p in forecast['predictions']):.1f} kW准备。"
            return {'choice':{'candidate_id':c['candidate_id'],'reason':reason},'llm':{'mode':'real','reason':'call_succeeded'}}
    p=Retry();out=orchestrator.run_agent(forecast,context,provider=p,dispatch_enabled=False)
    assert p.calls==1 and out['explanation_source']=='template' and out['source']=='llm' and out['receipt']['count']==0 and '999999' not in out['reason']


def test_chat_provider_prompt_receives_list_and_safe_instructions(monkeypatch):
    captured=[]
    class Response:
        def raise_for_status(self):pass
        def json(self):return {'choices':[{'message':{'tool_calls':[{'function':{'name':'chat_answer','arguments':json.dumps({'answer':'x'})}}]}}]}
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):captured.append(kwargs['json']['messages'][0]['content']);return Response()
    monkeypatch.setattr(provider,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(provider,'read_key',lambda:('fixture-credential','available'))
    monkeypatch.setattr(provider.httpx,'Client',Client)
    provider.OpenAICompatibleProvider().chat_call('answer',{'allowed_numeric_instruction':numeric_instruction({'savings_cny':12.3})})
    assert '12.3 | 接受时段改前减改后电费(元)' in captured[0] and 'EVERY excluded' in captured[0]


class Fake:
    def chat_call(self,phase,payload,feedback=''):
        if phase=='select':result={'tool':'hvac_compare','setpoint_c':26.}
        else:
            assert MARKER in payload['allowed_numeric_instruction']
            result={'answer':payload['grounded_reference']}
        return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}


@pytest.mark.parametrize('mode',['demo','real'])
@pytest.mark.parametrize('excluded_indices',[[],[0,10,23],list(range(23)),list(range(24))])
def test_json_stream_partial_all_or_no_refusal_same_hours(mode,excluded_indices,monkeypatch,tmp_path):
    data,row=fixture()
    for i in excluded_indices:row['forecast_24h'][i].update(abstain=True,risk_score=2.,risk_threshold=1.)
    original=copy.deepcopy(data)
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'replay_scenario',lambda name:data)
    monkeypatch.setattr(api,'ROOT',tmp_path)
    client=TestClient(api.app);q={'scenario':'normal','origin':row['t'],'question':'空调改26度能省多少电费'}
    out=client.post('/chat',json=q).json();assert out['grounded']
    accepted=24-len(excluded_indices)
    assert out['known'] and out['needs_human']==bool(excluded_indices)
    compare=out['tool_trace'][-1]['result'];assert out['tool_trace'][-1]['tool']=='compare_costs'
    assert compare['accepted_hours']==accepted and compare['excluded_hours']==len(excluded_indices)
    if accepted:assert '不按整天计算' in out['answer']
    assert all(w not in out['answer'] for w in ('影子','模拟','估算'))
    for e in compare['excluded']:
        if accepted:assert e['reason'] in out['answer']
        assert ('次日' in out['answer']) if e['day_label']=='次日' else True
        # Exact exclusion timestamps remain in tool evidence; prose may range-merge.
        assert e['hour']==int(e['timestamp'][11:13])
    sims={t['tool']:t['result'] for t in out['tool_trace'] if t['tool'].startswith('simulate_schedule')}
    if accepted:
        assert len(sims)==2 and out['known'] and '预计' in out['answer'] and '非实测' not in out['answer']
        before=sims['simulate_schedule_before'];after=sims['simulate_schedule_after']
        expected_t=[p['t'] for p in row['forecast_24h'] if not p['abstain']]
        assert [h['timestamp'] for h in before['hours']]==[h['timestamp'] for h in after['hours']]==expected_t
        tariff=tool_config()['tariff'];cost=0.
        for p in row['forecast_24h']:
            if p['abstain']:continue
            h=int(p['t'][11:13]);period='valley' if h in tariff['valley_hours'] else 'peak' if h in tariff['peak_hours'] else 'flat'
            cost+=1000*.955*tariff[period]
        assert before['estimated_cost']==pytest.approx(cost) and compare['before_cost']==round(cost,1)
        assert compare['savings_cny']==round(before['estimated_cost']-after['estimated_cost'],1)
        if mode=='real':assert out['answer_source']==('llm_tools' if compare['today_accepted_hours'] else 'deterministic_tools')
    else:
        assert not sims and all(compare[k] is None for k in ('before_cost','after_cost','savings_cny'))
        assert '算不出电费差额' in out['answer'] and '交值班人员处理' in out['answer']
    start=time.monotonic();events=list(chat_engine.events(q['question'],data,row,Fake() if mode=='real' else None))
    # 72f8c2b removes generic step; 87dfe94 adds composition mode to done.
    assert events[0]['type']=='tool_start' and time.monotonic()-start<15
    wire=client.post('/chat/stream',json=q)
    events=[json.loads(l.removeprefix('data: ')) for l in wire.text.splitlines() if l]
    assert events[0]['type']=='tool_start' and {k:v for k,v in events[-1].items() if k not in ('phase_timings','llm_reason','mode','session_id','terminated','category','classification_timing','classification_pending')}=={'type':'done','known':True,'needs_human':bool(excluded_indices),'grounded':True,'explanation_source':out['explanation_source'],'reason':'answered'}
    # 87dfe94/c250ee2: SSE explicitly reports composition and session policy state.
    assert events[-1]['mode']==out['mode'] and not events[-1]['terminated'] and events[-1]['category']=='none'
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    types=[e['type'] for e in events]
    assert types.index('tool_start')<types.index('tool_end')<types.index('answer_delta')<types.index('done')
    assert data==original and not (tmp_path/'logs/dispatch.jsonl').exists()


def test_refusal_reason_local_offset_and_scope_omission_fallback(monkeypatch):
    data,row=fixture();row['forecast_24h'][10].update(abstain=True,abstain_reason='interval_too_wide')
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Bad(Fake):
        def chat_call(self,phase,payload,feedback=''):
            out=super().chat_call(phase,payload,feedback)
            if phase=='answer':out['result']['answer']=payload['grounded_reference'].split('未计入时段：')[0]+'非实测情景，需要人工核对。'
            return out
    out=answer('空调改26度',data,row,Bad())
    assert out['known'] and out['answer_source']=='deterministic_tools' and out['llm']['reason']=='chat_comparison_scope_failed'
    assert '次日 01:00（负荷波动范围较大）' in out['answer']
    assert out['grounded'] and out['needs_human']


def test_partial_timezone_tariff_and_negative_difference(monkeypatch):
    from datetime import datetime,timezone
    data,row=fixture();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'demo'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    row['forecast_24h'][0]['abstain']=True
    normal=answer('空调改24度',data,row);assert normal['known']
    assert normal['tool_trace'][-1]['result']['savings_cny']<0  # higher cost, never claim saving
    for p in row['forecast_24h']:p['t']=datetime.fromisoformat(p['t']).astimezone(timezone.utc).isoformat()
    utc=answer('空调改24度',data,row)
    assert utc['known'] and utc['grounded']
    assert normal['tool_trace'][-1]['result']['before_cost']==utc['tool_trace'][-1]['result']['before_cost']
    assert normal['tool_trace'][-1]['result']['after_cost']==utc['tool_trace'][-1]['result']['after_cost']
    assert '15:00' in utc['answer'] and '今天 15:00' not in utc['answer']
    for p in row['forecast_24h']:p['abstain']=False
    row['abstain']=True;row['agent']['status']='handoff'
    all_accepted=answer('空调改26度',data,row)
    assert all_accepted['known'] and not all_accepted['needs_human']  # current gate is not a future comparison gate


def test_frozen_real_regression_complete_unchanged_controls_and_zero_final_unsupported():
    plan=json.loads(Path('experiments/grounding_prompt_v1_plan.json').read_text(encoding='utf-8'))
    rows=[json.loads(l) for l in Path('experiments/grounding_prompt_v1_pairs.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(rows)==len(plan['pairs'])==31 and [r['index'] for r in rows]==list(range(31))
    assert [{'date':r['date'],'hour':r['hour']} for r in rows]==plan['pairs']
    summary=json.loads(Path('experiments/grounding_prompt_v1_summary.json').read_text(encoding='utf-8'))
    actual=summarize(rows)
    assert actual['arms']==summary['arms'] and summary['status']=='completed'
    assert all(actual['arms'][label]['final_unsourced_numeric_tokens']==0 for label in ['before','after'])
    assert all(a['mode']=='real' for r in rows for label in ['before','after'] for a in r[label]['attempts'] if a['reason']=='call_succeeded')


def test_regression_summary_truthful_denominators_and_other_failures():
    def arm(reason,source,tokens):return {'llm':{'reason':reason},'source':source,'attempts':[{'reason':'call_succeeded','unsourced_numeric_token_count':tokens}],'final_unsourced_numeric_token_count':0}
    rows=[{'before':arm('grounding_failed','rule',2),'after':arm('call_succeeded','llm',0)},
        {'before':arm('call_succeeded','llm',0),'after':arm('call_failed','rule',0)}]
    s=summarize(rows)
    assert s['arms']['before']['grounding_fallback_rate']==.5 and s['arms']['after']['grounding_fallback_rate']==0
    assert s['arms']['after']['final_reasons']['call_failed']==1
    assert s['paired_transitions']=={'grounding_failed -> other':1,'other -> other':1}
