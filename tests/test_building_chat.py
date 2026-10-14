import json,time
from pathlib import Path
import pytest
from src.agent.chat import answer
from src.agent.chat_engine import events
from src.agent import building_tools,provider
from src.data.replay_payload import load_replay

# 72f8c2b: case humidity strings follow one-decimal chat readings.
CASES=json.loads(Path('tests/building_chat_cases.json').read_text(encoding='utf-8'))


@pytest.mark.parametrize('case',CASES,ids=[c['question'] for c in CASES])
def test_building_answer_has_tools_and_correct_values(monkeypatch,case):
    monkeypatch.setenv('LLM_MODE','demo')
    d=load_replay(case.get('scenario','normal'));origin_index=case.get('origin_index',14);r=d['hours'][origin_index]
    selector=None
    if case.get('general_answer'):
        from src.agent import chat_engine,web_search
        monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
        def public_fixture(question,*a,**k):
            if any(city in question for city in ('上海','伦敦')):
                city='伦敦（英国）' if '伦敦' in question else '上海（中国）'
                return {'status':'ok','city_weather':{'city':city},'answer':city+'当前气温 20.0 °C，次日最高 24.0 °C。',
                    'sources':[{'title':'Open-Meteo 天气','url':'https://api.open-meteo.com/v1/forecast','snippet':'当前和次日天气'}]}
            if '物理学奖' in question:
                return {'status':'ok','sources':[{'title':'2024 年物理学奖','url':'https://api.nobelprize.org/2/nobelPrize/phy/2024','snippet':'John Hopfield 和 Geoffrey Hinton'}]}
            return {'status':'ok','sources':[{'title':'公开知识','url':'https://example.org/knowledge','snippet':'常识'}]}
        monkeypatch.setattr(web_search,'search',public_fixture)
        from src.agent import city_weather
        monkeypatch.setattr(city_weather,'query',public_fixture)
        class General:
            def chat_call(self,phase,payload,feedback=''):
                if phase=='route':return {'result':{'choices':[{'tool':'general_chat','parameters':{}}]},'llm':{'mode':'real','reason':'call_succeeded'}}
                return {'result':{'answer':'运维常识：植物、电量、复利、温度、碳中和、电梯。2024 年物理学奖得主为 John Hopfield 和 Geoffrey Hinton。生日快乐，记得休息。'},'llm':{'mode':'real','reason':'call_succeeded'}}
        selector=General()
        # 3d4e37a: native public function-choice mock, question-specific text.
        # Exact-two birthday prose cannot follow two unrelated knowledge lines.
        if case['question']=='帮我写两句生日祝福' or (case['tool']=='web_search' and not case.get('recent_news_14_days')):
            class NativeGeneral(General):
                def agent_stream(self,messages,tools,seconds,first_seconds):
                    question=next(m['content'] for m in messages if m['role']=='user')
                    if case['tool']=='web_search' and not any(m['role']=='tool' for m in messages):
                        yield {'kind':'message','message':{'calls':[{'name':'web_search','arguments':json.dumps({'query':question})}]}}
                    else:
                        text=('生日快乐，愿你开心。愿你身体健康，记得休息。' if '生日' in question else
                              '2024 年物理学奖得主为 John Hopfield 和 Geoffrey Hinton。' if '物理学奖' in question else
                              '运维常识：植物、电量、复利、温度、碳中和、电梯。')
                        yield {'kind':'message','message':{'content':text}}
            selector=NativeGeneral()
    if case.get('semantic') and case['question']!='储能还剩多少电':
        from src.agent import chat_engine
        monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
        class Selector:
            def chat_call(self,phase,payload,feedback):
                assert any(t['name']=='storage_history' and '剩余' in t['description'] for t in payload['available_tools'])
                return {'result':{'choices':[{'tool':'storage_history','parameters':{}}]},'llm':{'reason':'call_succeeded'}}
        selector=Selector()
    out=answer(case['question'],d,r,selector,display_date='2026-10-12',display_time=case.get('display_time','14:00'))
    assert out['known'] and out['reason']=='answered' and out['grounded'],out
    assert case['tool'] is None or case['tool'] in [t['tool'] for t in out['tool_trace']]
    assert all(s in out['answer'] for s in case['contains']),out
    assert '不知道' not in out['answer']
    assert all(t not in out['answer'] for t in case.get('excludes',[]))
    if case.get('general_answer'):return
    trace=next(t['result'] for t in out['tool_trace'] if t['tool']==case['tool'])
    ops=json.loads(Path('exports/replay/normal.ops.json').read_text(encoding='utf-8'))
    if case['tool']=='energy_totals':
        for day in trace['days']:
            source=json.loads(Path(day['source']).read_text(encoding='utf-8'))
            hrs=source['hours'][:14] if day['date']=='2026-10-12' else source['hours']
            assert day['energy_kwh']['actual_kwh']==round(sum(h['energy']['hour_kwh']['actual_kwh'] for h in hrs),1)
            assert day['cost_cny']==round(sum(h['energy']['hour_cost_cny'] for h in hrs),1)
    elif case['tool']=='end_use':
        for key,share in trace['shares'].items():
            suffix='_kw' if trace['unit']=='kW' else '_kwh'
            assert share==round(trace['values'][key+suffix]/trace['total']*100,1)
    elif case['tool']=='floor_state':
        floors=json.loads(Path(trace['source']).read_text(encoding='utf-8'))
        assert trace['floor'] in floors['hours'][14]['floors']
    elif case['tool']=='alerts_orders':
        assert all(x['offset_ms']<=14*3600000 for x in trace['records'])
        assert trace['count']==len(trace['records'])
    elif case['tool']=='pv_generation':assert trace['generation_kwh']==round(sum(h['pv']['power_kw'] for h in ops['hours'][:14]),1)
    elif case['tool']=='storage_history':
        assert trace['charge_kwh']==round(sum(max(0,-h['storage']['power_kw']) for h in ops['hours'][:14]),1)
        assert trace['discharge_kwh']==round(sum(max(0,h['storage']['power_kw']) for h in ops['hours'][:14]),1)


def test_unmatched_building_query_uses_full_multitool_catalog(monkeypatch):
    from src.agent import chat_engine
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_call(self,phase,payload,feedback):
            assert phase=='route'
            assert all(t['display_name'] and t['description'] and t['parameters'] for t in payload['available_tools'])
            return {'result':{'choices':[{'tool':'floor_state','parameters':{'floor':18}},{'tool':'pv_generation','parameters':{}}]},'llm':{'reason':'call_succeeded','mode':'real'}}
    d=load_replay('normal');r=d['hours'][14]
    out=answer('楼宇数据里请帮我看看办公区和发电',d,r,Fake(),display_date='2026-10-12',display_time='14:00')
    assert out['known'] and len(out['tool_trace'])==2


def test_no_data_never_searches_or_claims_handoff(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    d=load_replay('abstain');r=d['hours'][14]
    out=answer('这个楼的业主叫什么',d,r)
    assert out['reason']=='no_data' and not out['known'] and not out['needs_human']
    # 72f8c2b: no-data sentence includes punctuation.
    assert out['answer']=='这个信息系统里没有。' and not out['llm_called'] and out['tool_trace']==[]
    assert '已转人工' not in out['answer']
    out=answer('2070-01-01用电量',d,r,display_date='2026-10-12')
    assert out['reason']=='answered' and not out['known'] and '这个数现在查不到' in out['answer']


def test_asof_excludes_future_alerts_and_energy():
    d=load_replay('normal');r=d['hours'][0]
    q=building_tools.execute_choice({'tool':'energy_totals'},'今天用了多少电',d,r,'2026-10-12','00:00')
    assert q['tool_trace'][0]['result']['total_kwh']==0
    q=building_tools.execute_choice({'tool':'alerts_orders'},'今天告警',d,r,'2026-10-12','10:59')
    assert q['tool_trace'][0]['result']['count']==0
    q=building_tools.execute_choice({'tool':'alerts_orders'},'今天告警',d,r,'2026-10-12','11:30')
    assert all(e['status']=='待核查' for e in q['tool_trace'][0]['result']['records'])


def test_all_done_have_reason_and_combined_fast_paths(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');r=d['hours'][14]
    for q in ['今天电费多少和L1电梯在哪','电费多少和天气怎么样','这个楼业主是谁']:
        out=list(events(q,d,r,display_date='2026-10-12',display_time='14:00'))
        assert out[-1]['type']=='done' and out[-1]['reason'] in ('answered','no_data','out_of_scope')


def test_invalid_parameters_cannot_open_user_path():
    d=load_replay('normal');r=d['hours'][14]
    for p in [{'date':'../../.env'},{'floor':99},{'days':50},{'path':'.env'}]:
        with pytest.raises(Exception):building_tools.execute_choice({'tool':'floor_state','parameters':p},'',d,r)


def test_semantic_selector_cannot_invent_floor_or_date(monkeypatch):
    from src.agent import chat_engine
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    class Fake:
        def chat_call(self,*a):return {'result':{'choices':[{'tool':'floor_state','parameters':{'floor':8}}]},'llm':{'reason':'call_succeeded'}}
    d=load_replay('normal');r=d['hours'][14]
    out=answer('办公室环境帮我核对一下',d,r,Fake(),display_date='2026-10-12',display_time='14:00')
    result=out['tool_trace'][0]['result']
    assert 'floors' in result and len(result['floors'])==40
    assert '8 层' not in out['answer']


def test_ordinary_air_and_traffic_are_building_scope(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    d=load_replay('normal');r=d['hours'][14]
    for q in ['云栖塔目前的客流与空气品质怎么样','办公室里空气闷不闷']:
        out=answer(q,d,r,display_date='2026-10-12',display_time='14:00')
        assert out['known'] and out['reason']=='answered'


def test_same_tool_two_dates_keeps_both_requests(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');r=d['hours'][14]
    out=answer('今天电费多少和昨天用电量',d,r,display_date='2026-10-12',display_time='14:00')
    traces=[t['result'] for t in out['tool_trace'] if t['tool']=='energy_totals']
    assert len(traces)==2 and [t['date'] for t in traces]==['2026-10-12','2026-10-11']
    assert out['known'] and '昨天全天' in out['answer'] and '今天截至' in out['answer']
