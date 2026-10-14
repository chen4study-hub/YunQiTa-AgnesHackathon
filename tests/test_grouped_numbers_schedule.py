from src.data.replay_payload import load_replay
import copy,json,re,subprocess
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.agent import chat_engine
from src.agent.orchestrator import check_grounding,ungrounded_numbers
from src.agent.display_text import numeric_tokens,number_text,public_text,display_evidence
from tests.test_public_display_text import assert_display,QUESTIONS


@pytest.mark.parametrize('raw,want',[
    ('1352.6 千瓦，16554.8元','1,352.6 kW，16,554.8 元'),
    ('1000千瓦时，999.9kW，89.3 %','1,000 kWh，999.9 kW，89.3%'),
    ('-1234567.00 kWh，+1000.0元','-1,234,567.00 kWh，+1,000.0 元'),
    ('1,352.6kW，16,554.8 元','1,352.6 kW，16,554.8 元'),
    ('今天 09:00，次日 13:00，500台','今天 09:00，次日 13:00，500台')])
def test_grouping_reversible_idempotent_and_exact_grounding(raw,want):
    origin='2017-10-23T09:00:00-05:00';e={'timestamp':'2017-10-24T13:00:00-05:00'}
    rendered=public_text(raw,origin,e)
    assert rendered==want and public_text(rendered,origin,e)==want
    assert numeric_tokens(raw)==numeric_tokens(want)
    assert check_grounding(want,{'values':[float(n) for n in numeric_tokens(raw)]})
    assert_display(want)


@pytest.mark.parametrize('raw',['12,34 kW','1,23,456 元','1,,352 kW'])
def test_malformed_grouping_not_accepted_as_grounded_fragments(raw):
    assert ungrounded_numbers(raw,{'values':[1,12,23,34,352,456,1234,123456,1352]})
    with pytest.raises(ValueError):number_text(raw)


def test_unknown_grouped_whole_value_still_fails():
    assert not check_grounding('99,999.9 kWh',{'fragments':[99,999.9]})
    assert ungrounded_numbers('99,999.9 kWh',{'fragments':[99,999.9]})==['99999.9']
    assert not check_grounding('SOC99,999.9%',{'fragments':[9,99,999.9]})


def assert_grouped(text):
    assert_display(text)
    assert number_text(text)==text
    assert not re.search(r'(?<![\d,])\d{4,}(?:\.\d+)?',text)


@pytest.mark.parametrize('mode',['demo','real'])
@pytest.mark.parametrize('question',QUESTIONS)
def test_chat_json_and_sse_complete_grounded_grouped_answers(monkeypatch,mode,question):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':mode})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Fake:
        def chat_call(self,phase,payload,feedback=''):
            if phase=='select':
                tool,sp=chat_engine.intent(payload['question']);result={'tool':tool,'setpoint_c':sp}
            else:
                # Test incoming ungrouped Chinese units and pre-grouped reference.
                text=payload['grounded_reference'].replace(' kW','千瓦').replace(' kWh','千瓦时').replace(' 元','元')
                result={'answer':text}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Fake)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    d=load_replay('normal');row=d['hours'][12]
    request={'scenario':'normal','origin':row['t'],'question':question};client=TestClient(api.app)
    response=client.post('/chat',json=request);assert response.status_code==200
    out=response.json();assert out['known'] and out['grounded'];assert_grouped(out['answer'])
    if mode=='real':assert out['answer_source']=='llm_tools'
    response=client.post('/chat/stream',json=request);assert response.status_code==200
    events=[json.loads(l.removeprefix('data: ')) for l in response.text.splitlines() if l]
    full=''.join(e['text'] for e in events if e['type']=='answer_delta')
    assert full==out['answer'] and events[-1]['grounded'];assert_grouped(full)


@pytest.mark.parametrize('text,expected_source,expected_wording',[
    ('选择通过约束的候选。','llm','llm'),('hold方案。','llm','template'),
    ('准备99,999.9千瓦。','llm','template')])
def test_schedule_top_level_provenance_and_grouped_reason(monkeypatch,tmp_path,text,expected_source,expected_wording):
    from datetime import datetime,timedelta
    monkeypatch.setattr(api,'ROOT',tmp_path)
    d=load_replay('normal');row=d['hours'][14]
    monkeypatch.setattr(api,'replay_hour',lambda *args:(d,row))
    class Fake:
        def choose_candidate(self,f,c,instruction):
            assert '1,352.6 kW' in instruction
            best=next(a for a in c if a['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':text},'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    request={'building_id':d['meta']['building_id'],'scenario':'normal','start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    response=TestClient(api.app).post('/schedule',json=request);assert response.status_code==200
    out=response.json();assert out['source']==expected_source and out['explanation_source']==expected_wording
    assert out['explanation_source'] in ('llm','template')
    selected=next(c for c in out['candidates'] if c['candidate_id']==out['selected'])
    assert out['explanation']==out['reason'] and f"{selected['objective_metrics']['upper_grid_peak_kw']:,.1f} kW" in out['reason']
    assert '99,999.9' not in out['reason']
    for s in [out['reason'],out['selection_reason']['summary']]+[p['reason'] for p in out['plan']]:assert_grouped(s)
    e=display_evidence(out['candidates'],row['t']);assert check_grounding(out['reason'],e)
    assert out['receipt']['count']==2 and not out['receipt']['device_connected']


@pytest.mark.parametrize('scenario,hour',[('normal',14),('abstain',12)])
def test_schedule_demo_and_refusal_have_template_provenance(monkeypatch,tmp_path,scenario,hour):
    from datetime import datetime,timedelta
    monkeypatch.setenv('LLM_MODE','demo');monkeypatch.setattr(api,'ROOT',tmp_path)
    d=load_replay(scenario);row=d['hours'][hour]
    monkeypatch.setattr(api,'replay_hour',lambda *args:(d,row))
    request={'building_id':d['meta']['building_id'],'scenario':scenario,'start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    response=TestClient(api.app).post('/schedule',json=request);assert response.status_code==200
    out=response.json();assert out['explanation_source']=='template';assert_grouped(out['reason'])
    if scenario=='abstain':assert out['source']=='rule' and out['receipt']['count']==0
    else:assert out['source']=='demo' and out['receipt']['count']==2


def test_grouped_unknown_chat_value_never_passes_json_or_sse(monkeypatch):
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    # 67e0900 freezes provider availability at API admission, before engine mocks.
    monkeypatch.setattr(api,'get_llm_status',lambda:chat_engine.get_llm_status())
    class Bad:
        def chat_call(self,phase,payload,feedback=''):
            result={'tool':'current_state','setpoint_c':None} if phase=='select' else {'answer':payload['grounded_reference']+'另有99,999.9千瓦时。'}
            return {'result':result,'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(chat_engine,'OpenAICompatibleProvider',Bad)
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Bad)
    d=load_replay('normal');row=d['hours'][12]
    request={'scenario':'normal','origin':row['t'],'question':'现在储能SOC多少'};client=TestClient(api.app)
    out=client.post('/chat',json=request).json();assert out['llm']['reason']=='call_succeeded' and out['grounded']
    assert out['llm']['prose_repair']['unknown_numeric_sentences']==1
    assert '99,999.9' not in out['answer'] and '99999.9' not in out['answer']
    events=[json.loads(l.removeprefix('data: ')) for l in client.post('/chat/stream',json=request).text.splitlines() if l]
    assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']


def test_reexports_only_grouping_and_no_source_control_or_economic_change():
    from scripts.refresh_display_text import refresh
    for name in ['normal','peak','abstain']:
        data=json.loads(subprocess.check_output(['git','show',f'c28a18e:exports/replay/{name}.json']).decode('utf-8'))
        old=json.loads(subprocess.check_output(['git','show',f'773db56:exports/replay/{name}.json']).decode('utf-8'))
        def without_grouping(obj):
            if isinstance(obj,str):
                from src.agent.display_text import ungroup_text
                return ungroup_text(obj)
            if isinstance(obj,list):return [without_grouping(v) for v in obj]
            if isinstance(obj,dict):return {k:without_grouping(v) for k,v in obj.items()}
            return obj
        assert without_grouping(data)==without_grouping(old)
        # Historical receipt predates current UI label policy; refresh now changes
        # that label. Numeric/control equality above still audits original grouping.
        refreshed=copy.deepcopy(data);refresh(refreshed)
        assert refreshed['energy_summary']['label']=='空调电耗占比（预计）'
        for row in data['hours']:
            a=row['agent'];assert a['explanation_source']==old['hours'][int(row['t'][11:13])]['agent']['explanation_source']
            assert_grouped(a['explanation']);assert_grouped(a['selection_reason']['summary'])
            assert check_grounding(a['explanation'],display_evidence(a,row['t']))
            for c in a['candidates']:
                assert_grouped(c['selection_reason']['summary'])
                for p in c['plan']:assert_grouped(p['reason'])


@pytest.mark.parametrize('legacy,clean',[
    ('峰值容差带内，选用当前方案。','在峰值允许范围内，选用当前方案。'),
    ('容差带内，选用当前方案。','在峰值允许范围内，选用当前方案。'),
    ('峰值容差带满足要求。','峰值允许范围满足要求。'),
    ('选用当前方案。按先电费、再负荷偏高时的峰值、再编号的排序。','选用当前方案。'),
    ('选用当前方案。最后再编号。','选用当前方案。'),
    ('选用当前方案。按编号排序。','选用当前方案。'),
    ('选用当前方案。使用未识别的容差规则。','选用当前方案。'),
])
def test_live_schedule_reason_has_no_tolerance_or_identifier_ranking(monkeypatch,tmp_path,legacy,clean):
    from datetime import datetime,timedelta
    from src.agent.display_text import operational_reason_text
    assert operational_reason_text(legacy)==clean
    assert operational_reason_text(clean)==clean
    monkeypatch.setattr(api,'ROOT',tmp_path)
    data=load_replay('normal');row=data['hours'][14]
    monkeypatch.setattr(api,'replay_hour',lambda *args:(data,row))
    class Fake:
        def choose_candidate(self,forecast,candidates,instruction):
            assert 'then id' not in instruction and 'then raw peak' not in instruction
            assert 'Delete the entire sentence describing identifier ranking' in instruction
            assert '在峰值允许范围内' in instruction and 'never mention 容差' in instruction
            best=next(c for c in candidates if c['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':legacy},
                'llm':{'mode':'real','reason':'call_succeeded'}}
    monkeypatch.setattr(api,'OpenAICompatibleProvider',Fake)
    request={'building_id':data['meta']['building_id'],'scenario':'normal','start':row['t'],
        'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
    response=TestClient(api.app).post('/schedule',json=request)
    assert response.status_code==200
    out=response.json()
    assert out['source']=='llm' and out['explanation_source']=='llm'
    assert clean in out['reason'] and out['explanation']==out['reason']
    texts=[out['reason'],out['selection_reason']['summary']]+[p['reason'] for p in out['plan']]
    for candidate in out['candidates']:
        texts.append(candidate['selection_reason']['summary'])
        texts.extend(p['reason'] for p in candidate['plan'])
    for text in texts:
        assert '容差' not in text and '编号' not in text
        assert_grouped(text)
    assert check_grounding(out['reason'],display_evidence(out['candidates'],row['t']))
    selected=next(c for c in out['candidates'] if c['candidate_id']==out['selected'])
    assert f"{selected['objective_metrics']['upper_grid_peak_kw']:,.1f} kW" in out['reason']
