import threading
import time
import pytest
from src.agent import chat_topic_hook as hook, topic_guard
from src.agent.chat_engine import consume
from src.agent.chat_display import reading_text
from src.agent.display_text import render_public_fields


def pipeline(source='template', tool='floor_state', mixed=False):
    def run():
        yield {'type':'tool_start','tool':tool}
        yield {'type':'answer_delta','text':'CO₂ 768.0 ppm。', 'sentence_source':'llm' if mixed or source=='llm' else 'template'}
        yield {'type':'done','known':True,'explanation_source':source}
        return {'answer':'CO₂ 768.0 ppm。','grounded':True,'known':True,'explanation_source':source,
                'answer_source':'llm_tools' if source=='llm' else 'deterministic_tools',
                'tool_trace':[{'tool':tool,'result':{'co2_ppm':768}}]}
    return run


@pytest.mark.parametrize('category',['politics','current_affairs'])
def test_local_only_returns_before_classification_then_terminates_and_audits(monkeypatch,category):
    release=threading.Event();marked=threading.Event();audits=[]
    monkeypatch.setattr(topic_guard,'_TERMINATED',set())
    monkeypatch.setattr(topic_guard,'record_chat_event',lambda *a,**kw: (audits.append(a),marked.set()))
    def classify(*a,**kw):
        assert release.wait(2)
        return {'category':category,'reason':'background verdict'}
    monkeypatch.setattr(topic_guard,'classify_topic',classify)
    g=hook.guarded_events('任意问题，不按关键词',[],'local-session',pipeline(),object())
    start=time.monotonic();out=consume(g)
    assert time.monotonic()-start<.2 and out['classification_pending'] and not topic_guard.is_terminated('local-session')
    release.set();assert marked.wait(1) and topic_guard.is_terminated('local-session')
    following=consume(hook.guarded_events('next',[],'local-session',lambda:pytest.fail('must not start tools'),object()))
    assert following['terminated'] and following['answer']=='会话已终止，请开启新会话。'
    assert len(audits)==1 and audits[0][2]==category


@pytest.mark.parametrize('source,tool,mixed',[('llm','floor_state',False),('template','floor_state',True),('template','city_weather',False),('template','web_search',False)])
def test_model_mixed_and_external_never_bypass(monkeypatch,source,tool,mixed):
    ready=threading.Event()
    monkeypatch.setattr(topic_guard,'is_terminated',lambda *a:False)
    def classify(*a,**kw):
        time.sleep(.06);ready.set();return {'category':'none','reason':'safe'}
    monkeypatch.setattr(topic_guard,'classify_topic',classify)
    events=list(hook.guarded_events('27层CO₂',[],'waiting',pipeline(source,tool,mixed),object()))
    assert ready.is_set() and not events[-1].get('classification_pending')
    assert not events[-1]['classification_timing'].get('local_data_bypass')


def test_unknown_provenance_is_not_pure_local():
    assert not hook.pure_local_answer({'answer':'text','grounded':True,'explanation_source':'template'})
    assert not hook.pure_local_answer({'answer':'text','grounded':True,'explanation_source':'template','tool_trace':[{'tool':'general_chat'}]})


def test_rate_two_decimal_every_presentation_pass_and_bill_one_decimal():
    text='电价0.35元/kWh、1.2元/kWh，小时电费1518.76元。'
    for _ in range(3):
        text=reading_text(render_public_fields({'answer':text})['answer'])
    assert '0.35 元/kWh' in text and '1.20 元/kWh' in text and '1,518.8 元' in text


def test_peak_low_confidence_reference_plain_language():
    from src.agent.chat_tools import execute
    from src.data.replay_payload import load_replay
    d=load_replay('normal');r=d['hours'][14]
    out=consume(execute('forecast_peak','明天负荷峰值',d,r))
    assert '这个时段预测把握不大，暂不自动执行' in out['answer']
    assert '预测被拒绝' not in out['answer']
