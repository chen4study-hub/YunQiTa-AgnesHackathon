import json
import threading
import time
from src.agent import agent_runner as runner, agent_tools as tools
from src.agent.agent_validation import validate_answer
from src.agent.chat_engine import consume
from tests.test_agent_v3 import Fake, call, fixture


def test_deadline_after_tool_returns_available_reading(monkeypatch):
    monkeypatch.setattr(runner, 'TOTAL_SECONDS', .4)
    monkeypatch.setattr(runner, 'FINALIZE_SECONDS', .1)
    class Stalled(Fake):
        def agent_stream(self, *args):
            if self.requests:
                time.sleep(.2)
                yield {'kind': 'failure', 'reason': 'agent_deadline'}
            else:
                self.requests.append(args)
                yield {'kind': 'first_token'}
                yield {'kind': 'message', 'message': {'calls': [call('current_state')]}}
    d, r=fixture();start=time.monotonic()
    result=consume(runner.events('储能SOC多少',d,r,Stalled([]),'2026-10-13','14:00'))
    assert result['answer'] and '36.4%' in result['answer']
    assert result['mode']=='fallback' and result['known'] and time.monotonic()-start<.5


def test_no_tool_result_is_nonempty_failure_not_fabricated_answer(monkeypatch):
    monkeypatch.setattr(runner, 'prefetch_plan', lambda q: ([], set()))
    class Timeout(Fake):
        def agent_stream(self,*a):
            yield {'kind':'failure','reason':'first_token_timeout'}
    d,r=fixture();result=consume(runner.events('储能SOC多少',d,r,Timeout([])))
    assert result['answer'] and not result['known'] and result['reason']=='no_data'
    assert result['explanation_source']=='template' and not result['tool_trace']


def test_finish_preserves_year_date_and_url_exactly():
    url='https://example.org/2026/123456?at=20261013'
    result=consume(runner.finish('2026-10-13；2026年，来源：'+url, [], 'llm', None, [], None, None))
    assert url in result['answer'] and '2026' in result['answer'] and '2,026' not in result['answer']


def test_city_weather_keeps_query_sources_in_final_model_and_fallback(monkeypatch):
    from src.agent import city_weather
    url='https://api.open-meteo.com/v1/forecast?latitude=31.123456&date=20261013'
    result={'status':'ok','answer':'上海当前气温 21.0 °C。',
            'sources':[{'title':'Open-Meteo 上海天气','url':url}]}
    monkeypatch.setattr(city_weather,'query',lambda *a,**kw:result)
    d,r=fixture();record=tools.run_tool('city_weather',{'city':'上海'},d,r,'2026-10-13','14:00',2,threading.Event(),'上海天气')  # 77c2847: weather intent must be supplied
    good,issues=validate_answer('上海气温21.0°C。',[record],'上海天气')
    assert not issues and url in good and '来源：' in good and 'Open-Meteo' in good
    fallback=runner.template_records([record]);assert url in fallback
    final=consume(runner.finish(good,[record],'llm',None,[],None,None))
    assert url in final['answer'] and '20261013' in final['answer']


def test_receipt_concept_only_requires_tool_and_actual_values():
    assert any(i['reason']=='actual_receipt_tool_required' for i in validate_answer('回执是下发确认。',[],'执行回执是什么')[1])
    d,r=fixture();record=tools.run_tool('execution_receipt',{},d,r,'2026-10-13','14:00',2,threading.Event())
    assert validate_answer('这是BA/EMS下发日志回执。',[record],'执行回执是什么')[1]
    assert not validate_answer(record['reference'],[record],'执行回执是什么')[1]
    assert '0 条指令' in runner.template_records([record])


def test_grid_cannot_be_total_building_load():
    d,r=fixture();record=tools.run_tool('building_state',{},d,r,'2026-10-13','14:00',2,threading.Event(),'总负荷')
    assert any(i.get('reason')=='total_load_value_mismatch' for i in validate_answer('总负荷820.1kW。',[record],'总负荷')[1])
    assert not validate_answer('总负荷1,258.1 kW。',[record],'总负荷')[1]


def test_knowledge_not_allowed_to_replace_cumulative_energy():
    assert any(i.get('reason')=='cumulative_energy_tool_required' for i in validate_answer('当前光伏114.3kW。',[],'今日累计用电量')[1])
    assert '瞬时' in tools.BY_NAME['current_energy']['description']
    assert '不是grid_kw' in tools.BY_NAME['building_state']['description']
    assert '累计' in tools.BY_NAME['energy_totals']['description']


def test_tool_reference_retains_original_question_scope():
    d,r=fixture();record=tools.run_tool('end_use',{'scope':'current'},d,r,'2026-10-13','14:00',2,threading.Event(),'当前电梯占比')
    assert '电梯' in record['reference'] and '空调' not in record['reference']


def test_nonanswer_json_rejected():
    assert any(i.get('reason') in ('non_answer_payload', 'internal_identifier') for i in validate_answer('[{"type":"text","text":"你好。"}]',[],'你好')[1])
