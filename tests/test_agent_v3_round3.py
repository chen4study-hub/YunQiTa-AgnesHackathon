import threading
import pytest
from src.agent import agent_runner as runner, agent_tools as tools
from src.agent.agent_prefetch import plan
from src.agent.agent_validation import validate_answer
from src.agent.agent_relevance import relevant, filter_result
from src.agent.answer_filter import ThinkFilter, strip_thoughts
from src.agent.chat_display import reading_text
from tests.test_agent_v3 import Fake, fixture


@pytest.mark.parametrize('q', ['今天储能充电量','今天储能放电量','储能累计充电量','电池一共放了多少电','截至现在累计放电量'])
def test_storage_cumulative_not_soc(q):
    d,r=fixture()
    assert tools.normalize_call('current_state',{},q)==('storage_history',{})
    rec=tools.run_tool('storage_history',{},d,r,'2026-10-13','14:00',1,threading.Event(),q)
    assert rec['trace'][0]['tool']=='storage_history'
    assert rec['trace'][0]['result']['charge_kwh']==802.4
    assert rec['trace'][0]['result']['discharge_kwh']==750.0
    assert plan(q)[0][0]['name']=='storage_history'
    assert validate_answer('当前储能电量36.4%。',[rec],q)[1]


@pytest.mark.parametrize('q', ['现在储能电量','当前电池SOC','电池剩多少电'])
def test_storage_current_soc(q):
    assert tools.normalize_call('storage_history',{},q)==('current_state',{})
    assert plan(q)[0][0]['name']=='current_state'


def test_storage_power_not_total():
    assert tools.normalize_call('storage_history',{},'现在储能功率')==('current_energy',{})
    assert tools.normalize_call('current_state',{},'今天储能充电量')[0]=='storage_history'


@pytest.mark.parametrize('text,expected', [
    ('<think>秘密。数字999</think>答复。','答复。'),
    ('前文。<think>秘密<think>嵌套</think>仍秘密</think>答复。','前文。答复。'),
    ('秘密。< / fake > </think>答复。','答复。'),
    ('答复。<think>未结束秘密','答复。'),
    ('<THINK>秘密</THINK>答复。','答复。')])
def test_strip_thoughts(text,expected):
    assert strip_thoughts(text)==expected


def test_fragmented_thoughts_before_any_output():
    parts=['<th','ink>秘密。','更多','</thi','nk>答案。','<thi','nk>第二段秘密</think>完。']
    f=ThinkFilter();emitted=[f.feed(p) for p in parts]
    assert all('秘密' not in p and 'think' not in p for p in emitted)
    assert ''.join(emitted)=='答案。完。'


def test_v3_answer_events_never_expose_thoughts():
    d,r=fixture();p=Fake([{'content':'<think>这是一段秘密推理。</think>当前储能电量36.4%。'}])
    events=list(runner.events('储能SOC多少',d,r,p,'2026-10-13','14:00'))
    text=''.join(e['text'] for e in events if e['type']=='answer_delta')
    assert '秘密' not in text and 'think' not in text and '36.4%' in text


def test_news_candidates_are_not_keyword_rejected_even_with_incidental_snippet():
    for title in ['中央气象台首席预报员：天气医生','蒙古国的操作正在吞噬四十年的奋斗成果','基金投资的三个技巧']:
        assert relevant('北京天气新闻',{'title':title,'snippet':'北京近日暴雨天气，空气污染严重'})
    assert relevant('北京天气新闻',{'title':'北京明日起降温降雨，最低气温下降'})
    assert relevant('北京天气新闻',{'title':'今日实况通报','body':'北京今天出现暴雨，气温下降，市气象台发布预警。'})


def test_news_empty_is_only_empty_no_weather_even_at_deadline(monkeypatch):
    d,r=fixture();city={'success':True,'data':{'sources':[{'url':'https://weather.org','title':'北京天气'}]},
                     'trace':[{'tool':'city_weather','result':{}}],'reference':'北京晴。来源：https://weather.org'}
    assert runner.template_records([city],'北京天气新闻')=='没查到相关报道。'
    assert validate_answer('北京天气晴。来源：https://weather.org',[city],'北京天气新闻')[0]=='没查到相关报道。'
    # 77c2847 permits model-selected weather for weather questions, even news;
    # an unavailable weather trace cannot become news evidence. No real network.
    from src.agent import city_weather
    monkeypatch.setattr(city_weather,'query',lambda *a,**kw:{'status':'unavailable','sources':[]})
    rec=tools.run_tool('city_weather',{'city':'北京'},d,r,'2026-10-13','14:00',1,threading.Event(),'北京天气新闻')
    assert not rec['success'] and rec['trace']==[{'tool':'city_weather','result':{'status':'unavailable','sources':[]}}]
    assert runner.template_records([rec],'北京天气新闻')=='没查到相关报道。'
    empty=filter_result('北京天气新闻',{'status':'deadline','sources':[]})
    assert empty['answer']=='没查到相关报道。'


def test_legacy_public_stream_filters_split_thoughts_before_emitting():
    from src.agent.general_chat import events
    class Provider:
        def chat_stream(self, payload):
            for text in ['<thi','nk>秘密。','</th','ink>植物吸收阳光。']:
                yield {'type':'text_delta','text':text}
            yield {'type':'done','llm':{'reason':'call_succeeded'}}
    chunks=list(events('什么是光合作用',Provider()))
    answer=''.join(e['text'] for e in chunks if e['type']=='answer_delta')
    assert answer=='植物吸收阳光。' and all('秘密' not in str(e) for e in chunks)


def test_city_validation_accepts_mixed_actual_trace_record_shapes():
    city={'tool':'city_weather','result':{'city':'上海'}}
    sources=[{'url':'https://api.open-meteo.com/v1/forecast','title':'Open-Meteo 上海天气'}]
    records=[{'success':True,'trace':[city],'data':[city],'evidence':{}},
             {'success':True,'trace':[city],'data':{'sources':sources},'evidence':[]}]
    answer,issues=validate_answer('上海天气晴。',records,'上海天气怎么样')
    assert 'https://api.open-meteo.com/v1/forecast' in answer and not issues


def test_receipt_spacing_shared_formatter_preserves_url():
    url='https://example.org/3ms?count=3'
    assert reading_text('确认3条，耗时1.1ms。'+url)=='确认3 条，耗时1.1 ms。'+url
    assert reading_text('确认0条，耗时0.0毫秒。')=='确认0 条，耗时0.0 毫秒。'
