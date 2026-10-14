from src.data.replay_payload import load_replay
import copy,json,re,subprocess
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.orchestrator import run_agent,check_grounding,ungrounded_numbers,reason_format_invalid
from src.agent.display_text import unit_text,public_text,display_evidence,DISPLAY_INSTRUCTION,BANNED_USER_WORDS
from tests.test_storage_rolling import inputs


def assert_display(text):
    assert not any(w in text for w in BANNED_USER_WORDS)
    assert not re.search(r'(?<!\d)(?:2016|2017)(?!\d)',text)
    assert not re.search(r'\d{4}年|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日',text)
    assert not any(s in text for s in ['千瓦','千瓦时','摄氏度','℃'])
    assert not re.search(r'\d\s+[%％]',text)
    for m in re.finditer(r'(\d+(?:\.\d+)?)(\s*)(kWh|kW|元|°C|%)',text):
        assert m[2]==('' if m[3]=='%' else ' ')
    assert not re.search(r'[零一二三四五六七八九十]{1,3}[时点]',text)
    for m in re.finditer(r'(今天|次日)\s*\d',text):
        assert re.match(r'(今天|次日) \d{2}:\d{2}',text[m.start():])


@pytest.mark.parametrize('raw,want',[
    ('1279.7千瓦','1279.7 kW'),('1348.7 千瓦','1348.7 kW'),('100千瓦时','100 kWh'),
    ('-10kwh，25.5度，35元，89.3 %','-10 kWh，25.5 °C，35 元，89.3%'),
    ('10 KW，26℃，27 ° C，89.3％','10 kW，26 °C，27 °C，89.3%')])
def test_units_exact_numeric_tokens_preserved(raw,want):
    assert unit_text(raw)==want and unit_text(want)==want
    numbers=re.findall(r'[-+]?\d+(?:\.\d+)?',raw)
    assert numbers==re.findall(r'[-+]?\d+(?:\.\d+)?',want)
    assert ungrounded_numbers(raw,{'numbers':[float(n) for n in numbers]})==ungrounded_numbers(want,{'numbers':[float(n) for n in numbers]})==[]
    assert not reason_format_invalid(want)


@pytest.mark.parametrize('raw', ['2017年10月24日13时','2017-10-24T13:00:00-05:00','次日十三时','次日 13:00'])
def test_origin_not_server_clock_and_verified_calendar(raw):
    origin='2017-10-23T12:00:00-05:00';e={'timestamp':'2017-10-24T13:00:00-05:00'}
    rendered=public_text(raw,origin,e)
    assert rendered=='次日 13:00'
    assert_display(rendered)
    assert check_grounding(rendered,display_evidence(e,origin))
    with pytest.raises(ValueError):public_text('2017年10月25日13时',origin,e)
    with pytest.raises(ValueError):public_text('次日 14:00',origin,e)


def test_clock_lists_use_explicit_day_not_guess():
    origin='2017-10-23T09:00:00-05:00'
    evidence=[{'timestamp':f'2017-10-23T{h:02d}:00:00-05:00'} for h in [10,12]]
    assert public_text('今日十时、十二时',origin,evidence)=='今天 10:00、今天 12:00'
    with pytest.raises(ValueError):public_text('十时、十二时',origin,evidence)
    with pytest.raises(ValueError):public_text('2016年10月23日10时',origin,evidence)


def fixture():
    data=load_replay('normal');return data,data['hours'][12]


QUESTIONS=['为什么这样调度','现在储能SOC多少','未来24小时峰值什么时候','明天最高负荷','空调改26度电费多少','为什么转人工','执行回执']
@pytest.mark.parametrize('mode',['demo','real'])
@pytest.mark.parametrize('question',QUESTIONS)
def test_chat_and_stream_units_dates_and_same_grounded_answer(monkeypatch,question,mode):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':
                tool,sp=chat_engine.intent(payload['question']);result={'tool':tool,'setpoint_c':sp}
            else:
                text=payload['grounded_reference'].replace('推算','估计').replace('等值班人员复核','待人工确认').replace(' kW','千瓦').replace(' °C','度').replace(' 元','元').replace('%',' %')
                # Real provider regression: returns original-date prose with supported numeric values.
                if payload['selected_tool']=='forecast_peak':
                    trace=payload['tools']['tools'];peak=next(t['result'] for t in trace if t['tool']=='forecast_peak')
                    clock=f"{peak['day_label']} {peak['hour']:02d}:{peak['minute']:02d}"
                    text=text.replace(clock,f"{peak['year']}年{peak['month']}月{peak['day']}日{peak['hour']}时")
                result={'answer':text}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    data,row=fixture();client=TestClient(api.app)
    payload={'scenario':'normal','origin':row['t'],'question':question}
    response=client.post('/chat',json=payload);assert response.status_code==200
    out=response.json();assert out['known'] and out['grounded'];assert_display(out['answer'])
    if mode=='real':assert out['answer_source']=='llm_tools'
    stream=client.post('/chat/stream',json=payload);assert stream.status_code==200
    events=[json.loads(l.removeprefix('data: ')) for l in stream.text.splitlines() if l]
    answer=''.join(e['text'] for e in events if e['type']=='answer_delta')
    assert answer==out['answer'] and events[-1]['grounded'];assert_display(answer)
    for e in events:
        for field in ['text','summary','message']:
            if field in e and e['type']!='answer_delta':assert_display(e[field])
    # Machine dates and tool_trace stay original; no disguised re-dating of source data.
    assert out['origin'].startswith('2017-')


@pytest.mark.parametrize('scenario,hour',[('normal',12),('abstain',12)])
def test_schedule_reason_plan_and_work_order_text(monkeypatch,tmp_path,scenario,hour):
    monkeypatch.setenv('LLM_MODE','demo');monkeypatch.setattr(api,'ROOT',tmp_path)
    data=load_replay(scenario);row=data['hours'][hour]
    monkeypatch.setattr(api,'replay_hour',lambda *args:(data,row))
    from datetime import datetime,timedelta
    payload={'scenario':scenario,'building_id':data['meta']['building_id'],'start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    out=TestClient(api.app).post('/schedule',json=payload)
    assert out.status_code==200;r=out.json()
    for text in [r['reason'],r['explanation'],r['selection_reason']['summary']]+[p['reason'] for p in r['plan']]:assert_display(text)
    for w in r['work_orders']:
        assert w['timestamp'].startswith('2017-')
        for text in w['possible_reasons']+w['suggested_checks']:assert_display(text)
    from src.agent.rolling_context import from_replay
    forecast,_,_=from_replay(data,row,.5)
    assert len(r['plan'])==24 and all(p['battery_kw']==0 for p,f in zip(r['plan'],forecast['predictions']) if f['abstain'])


def test_schedule_date_draft_sanitized_without_masking_unsupported_values():
    f,c,k=inputs('normal',14)
    class Provider:
        calls=0
        def choose_candidate(self,forecast,candidates,instruction):
            self.calls+=1;assert DISPLAY_INSTRUCTION in instruction
            best=next(a for a in candidates if a['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':f"2017年10月24日13时准备{best['objective_metrics']['upper_grid_peak_kw']:.1f}千瓦。"},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=run_agent(f,c,k,provider=Provider(),dispatch_enabled=False)
    assert_display(r['reason']);assert r['source']=='llm' and r['explanation_source']=='llm'
    assert '次日 13:00' in r['reason'] and f"{next(a for a in r['candidates'] if a['candidate_id']==r['selected'])['objective_metrics']['upper_grid_peak_kw']:,.1f} kW" in r['reason']
    class Bad(Provider):
        def choose_candidate(self,*args):
            v=super().choose_candidate(*args);v['choice']['reason']+='99999千瓦时。';return v
    bad=Bad();r=run_agent(f,c,k,provider=bad,dispatch_enabled=False)
    assert bad.calls==1 and r['source']=='llm' and r['explanation_source']=='llm'
    assert r['llm']['prose_repair']['dropped_sentences']==1
    assert '99999' not in r['reason'];assert_display(r['reason'])


@pytest.mark.parametrize('draft',BANNED_USER_WORDS)
def test_banned_llm_words_never_reach_json_or_sse(monkeypatch,draft):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'current_state','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']+draft+'。非实测。'}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    data,row=fixture();request={'scenario':'normal','origin':row['t'],'question':'现在储能SOC多少'}
    client=TestClient(api.app);answer=client.post('/chat',json=request).json()
    assert answer['known'] and answer['grounded'];assert_display(answer['answer'])
    stream=client.post('/chat/stream',json=request)
    events=[json.loads(l.removeprefix('data: ')) for l in stream.text.splitlines() if l]
    joined=''.join(e['text'] for e in events if e['type']=='answer_delta')
    assert joined==answer['answer'];assert_display(joined)


def test_chat_unsupported_numeric_value_after_unit_and_date_normalization(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Bad:
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'current_state','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']+'另外999999.9千瓦时。待人工确认。'}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Bad)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Bad)
    _,row=fixture();request={'scenario':'normal','origin':row['t'],'question':'现在储能SOC多少'}
    client=TestClient(api.app);out=client.post('/chat',json=request).json()
    assert out['llm']['reason']=='call_succeeded' and out['answer_source']=='llm_tools'
    assert out['llm']['prose_repair']['unknown_numeric_sentences']==1
    assert '999999.9' not in out['answer'];assert_display(out['answer'])
    stream=client.post('/chat/stream',json=request)
    events=[json.loads(l.removeprefix('data: ')) for l in stream.text.splitlines() if l]
    answer=''.join(e['text'] for e in events if e['type']=='answer_delta')
    assert answer==out['answer'];assert_display(answer)


def test_all_backend_served_user_visible_strings_banned_word_scan():
    from src.agent import display_text
    count=0
    visible={'title','display_name','explanation','summary','reason','actions','possible_reasons','suggested_checks','label'}
    for path in Path('exports').rglob('*.json'):
        def walk(obj,key=''):
            nonlocal count
            if isinstance(obj,dict):
                for k,v in obj.items():walk(v,k)
            elif isinstance(obj,list):
                for v in obj:walk(v,key)
            elif isinstance(obj,str) and key in visible:
                count+=1;assert not any(w in obj for w in display_text.BANNED_USER_WORDS),(str(path),key)
        walk(json.loads(path.read_text(encoding='utf-8')))
    assert count>1000


def test_three_reexports_only_user_text_changed_and_sources_preserved():
    for name in ['normal','peak','abstain']:
        current=json.loads(subprocess.check_output(['git','show',f'773db56:exports/replay/{name}.json']).decode('utf-8'))
        before=json.loads(subprocess.check_output(['git','show',f'aef89d8:exports/replay/{name}.json']).decode('utf-8'))
        sanitized=copy.deepcopy(current)
        for row,old,target in zip(current['hours'],before['hours'],sanitized['hours']):
            a=row['agent'];e=display_evidence(a,row['t']);assert check_grounding(a['explanation'],e)
            assert_display(a['explanation']);assert_display(a['selection_reason']['summary'])
            if a['explanation_source']!=old['agent']['explanation_source']:
                assert a['source']==old['agent']['source']=='llm' and a['explanation_source']=='template'
                assert a['llm']['explanation_mode']=='template'
            target['agent']['explanation_source']=old['agent']['explanation_source']
            target['agent']['llm']=old['agent']['llm']
            target['agent']['explanation']=old['agent']['explanation']
            target['agent']['selection_reason']['summary']=old['agent']['selection_reason']['summary']
            target['agent']['actions']=old['agent']['actions']
            target['agent']['work_orders']=old['agent']['work_orders']
            for c,oldc,targetc in zip(a['candidates'],old['agent']['candidates'],target['agent']['candidates']):
                assert_display(c['selection_reason']['summary'])
                targetc['selection_reason']['summary']=oldc['selection_reason']['summary']
                for p,oldp,targetp in zip(c['plan'],oldc['plan'],targetc['plan']):
                    assert_display(p['reason']);targetp['reason']=oldp['reason']
        # Historical label is frozen; apply current wording only for display check.
        from src.agent.display_text import wording_text
        assert_display(wording_text(current['energy_summary']['label']))
        sanitized['energy_summary']['label']=before['energy_summary']['label']
        assert sanitized==before
