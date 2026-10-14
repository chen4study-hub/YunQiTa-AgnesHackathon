from src.data.replay_payload import load_replay
import copy,json,re
from pathlib import Path
from datetime import datetime,timedelta
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.display_text import (public_text,display_date_text,render_public_fields,
    BANNED_USER_WORDS,CALENDAR_NAMES,PUBLIC_TEXT_FIELDS)


def clean(text,absolute=False):
    assert not any(w in text for w in BANNED_USER_WORDS)
    assert not CALENDAR_NAMES.search(text)
    assert not re.search(r'星期|周[一二三四五六日天]|201[67]',text)
    if not absolute:assert not re.search(r'\d{4}[-年/]\d{1,2}|\d{1,2}月\d{1,2}[日号]',text)


def visible(obj,key=''):
    if isinstance(obj,dict):
        for k,v in obj.items():yield from visible(v,k)
    elif isinstance(obj,list):
        for v in obj:yield from visible(v,key)
    elif isinstance(obj,str) and key in PUBLIC_TEXT_FIELDS:yield obj


@pytest.mark.parametrize('draft',list(BANNED_USER_WORDS)+['星期一','周四','国庆节','感恩节','Christmas','Monday','劳动节'])
def test_unified_wording_and_verified_clock(draft):
    origin='2017-10-23T12:00:00-05:00';e={'timestamp':'2017-10-24T13:00:00-05:00'}
    text=public_text(draft+'。2017年10月24日13时；99,999.9 kWh。非实测。',origin,e)
    clean(text);assert '次日 13:00' in text and '99,999.9 kWh' in text and '非实测' not in text
    assert public_text(text,origin,e)==text
    assert public_text('该情景估计并非实测数据',origin,e)==''


@pytest.mark.parametrize('anchor,nextday',[('2026-12-31','2027-01-01'),('2028-02-28','2028-02-29'),('2028-02-29','2028-03-01')])
def test_anchor_display_only_and_no_anchor_no_absolute(anchor,nextday):
    text='今天 23:00，次日 00:00'
    assert display_date_text(text)==text
    out=display_date_text(text,anchor);assert out==text
    assert display_date_text(text,anchor,include_date=True).count(anchor)==1
    d={'t':'2017-10-23T23:00:00-05:00','reason':text,'candidate_id':'typical_day','value':1234.5}
    r=render_public_fields(d,anchor)
    assert r['t']==d['t'] and r['candidate_id']==d['candidate_id'] and r['value']==d['value']


def data():
    d=load_replay('normal');return d,d['hours'][12]


@pytest.mark.parametrize('display_date',[None,'2026-12-31'])
@pytest.mark.parametrize('mode',['demo','real'])
@pytest.mark.parametrize('question',['为什么这样调度','明天最高负荷','空调改26度电费多少'])
def test_chat_stream_same_sanitized_dates_grounding_and_provenance(monkeypatch,display_date,mode,question):
    d,row=data();original=copy.deepcopy(d)
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':
                tool,sp=chat_engine.intent(payload['question']);v={'tool':tool,'setpoint_c':sp}
            else:v={'answer':payload['grounded_reference']+'星期一国庆，典型日代表日高温日节假日情景估计。预测值，非实测。'}
            return {'result':v,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    request={'scenario':'normal','origin':row['t'],'question':question}
    if display_date:request['display_date']=display_date
    client=TestClient(api.app);res=client.post('/chat',json=request);assert res.status_code==200
    out=res.json();assert out['known'] and out['grounded'];clean(out['answer'],bool(display_date))
    if mode=='real':assert out['explanation_source']=='llm'
    events=[json.loads(l.removeprefix('data: ')) for l in client.post('/chat/stream',json=request).text.splitlines() if l]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
    # Stream chunks are arbitrary slices: scan their joined text, not partial dates.
    for e in events:
        if e['type']!='answer_delta':
            for text in visible(e):clean(text)
    for text in visible(out):clean(text,bool(display_date))
    assert not re.search(r'\d{4}-\d{2}-\d{2}',out['answer'])
    assert out['origin']==row['t'] and d==original


@pytest.mark.parametrize('display_date',[None,'2028-02-28'])
def test_schedule_nested_text_only_date_alias(monkeypatch,tmp_path,display_date):
    monkeypatch.setenv('LLM_MODE','demo');d,row=data();original=copy.deepcopy(d)
    monkeypatch.setattr(api,'ROOT',tmp_path);monkeypatch.setattr(api,'replay_hour',lambda *a:(d,row))
    request={'scenario':'normal','building_id':d['meta']['building_id'],'start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    client=TestClient(api.app);base=client.post('/explain',json=request).json()
    if display_date:request['display_date']=display_date
    res=client.post('/schedule',json=request);assert res.status_code==200;out=res.json()
    for text in visible(out):clean(text,bool(display_date))
    assert out['plan'][0]['timestamp']==row['t'] and len(out['plan'])==24
    if display_date:
        assert not re.search(r'\d{4}-\d{2}-\d{2}',out['reason'])
        assert out['selection_reason']['metrics']==base['selection_reason']['metrics']
    assert d==original


@pytest.mark.parametrize('bad',['2026-2-01','2017/10/23','2026-02-29','2026-13-01','2026-10-12T00:00:00','9999-12-31',123])
def test_invalid_display_date_no_provider_or_dispatch(monkeypatch,tmp_path,bad):
    d,row=data();monkeypatch.setattr(api,'ROOT',tmp_path)
    monkeypatch.setattr(api,'tool_answer',lambda *a,**k:pytest.fail('must not invoke chat'))
    monkeypatch.setattr(api,'run_agent',lambda *a,**k:pytest.fail('must not invoke agent'))
    client=TestClient(api.app)
    q={'scenario':'normal','origin':row['t'],'question':'为什么这样调度','display_date':bad}
    for path in ['/chat','/chat/stream']:assert client.post(path,json=q).status_code==422
    s={'building_id':d['meta']['building_id'],'scenario':'normal','start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat(),'display_date':bad}
    assert client.post('/schedule',json=s).status_code==422
    assert not (tmp_path/'logs/dispatch.jsonl').exists()


@pytest.mark.parametrize('raw',['2026/10/12','2026.10.12','十月十二日','10月12号','2026年'])
def test_unverified_calendar_formats_never_leak(raw):
    with pytest.raises(ValueError):public_text(raw,'2017-10-23T12:00:00-05:00',{})


def test_current_date_exports_text_only_and_no_forbidden_words():
    import subprocess
    from scripts.refresh_live_display import without_prose
    receipt=json.loads(Path('experiments/live_display_refresh.json').read_text())
    count=0
    # Audit exactly the historical tree, not exports introduced in later rounds.
    paths=subprocess.check_output(['git','ls-tree','-r','--name-only','08cfb8e','exports']).decode().splitlines()
    for path in (Path(p) for p in paths if p.endswith('.json')):
        d=json.loads(subprocess.check_output(['git','show','08cfb8e:'+path.as_posix()]))
        old=json.loads(subprocess.check_output(['git','show','907a450:'+path.as_posix()]))
        assert without_prose(d)==without_prose(old)
        for text in visible(d):
            # Frozen historical receipt is not retroactively reworded; newer
            # bans are asserted against current exports in compact prose tests.
            assert not any(w in text for w in BANNED_USER_WORDS if w not in ('非实测','不是实测','推算','沿用'))
            assert not CALENDAR_NAMES.search(text);count+=1
    assert count>1000 and receipt['new_llm_calls']==receipt['new_dispatches']==0
    assert receipt['controls_economics_and_sources_preserved']


def test_bad_number_not_erased_by_word_cleanup_or_display_date(monkeypatch):
    d,row=data();monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Bad:
        def chat_call(self,phase,payload,feedback=''):
            r={'tool':'current_state','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']+'国庆典型日999999.9千瓦。'}
            return {'result':r,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Bad)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Bad)
    out=TestClient(api.app).post('/chat',json={'scenario':'normal','origin':row['t'],'question':'储能SOC多少','display_date':'2026-10-12'}).json()
    assert out['explanation_source']=='llm' and out['llm']['prose_repair']['unknown_numeric_sentences']==1
    assert '999999' not in out['answer'];clean(out['answer'],True)


def test_schedule_real_draft_calendar_names_cleaned_before_display_alias(monkeypatch,tmp_path):
    from src.agent.orchestrator import run_agent
    from tests.test_storage_rolling import inputs
    f,c,k=inputs('normal',14)
    class Provider:
        def choose_candidate(self,forecast,candidates,instruction):
            best=next(a for a in candidates if a['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':f"星期二国庆节代表日：2017年10月24日13时准备{best['objective_metrics']['upper_grid_peak_kw']:.1f}千瓦。该情景估计并非实测数据。"},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=run_agent(f,c,k,provider=Provider(),dispatch_enabled=False)
    assert r['source']=='llm' and r['explanation_source']=='llm'
    out=render_public_fields(r,'2026-12-31')
    assert '次日 13:00' in out['reason'] and '2027-01-01' not in out['reason'] and f"{next(a for a in r['candidates'] if a['candidate_id']==r['selected'])['objective_metrics']['upper_grid_peak_kw']:,.1f} kW" in out['reason']
    for text in visible(out):clean(text,True)
    assert out['plan']==render_public_fields(r['plan'],'2026-12-31')
    assert out['plan'][0]['timestamp']==f['predictions'][0]['timestamp']


def test_bare_clock_qualified_only_when_unambiguous():
    origin='2017-10-23T12:00:00-05:00'
    assert public_text('峰值13:00',origin,{'timestamp':'2017-10-24T13:00:00-05:00'})=='峰值次日 13:00'
    with pytest.raises(ValueError):public_text('峰值13:00',origin,[{'timestamp':f'2017-10-{d}T13:00:00-05:00'} for d in [23,24]])
