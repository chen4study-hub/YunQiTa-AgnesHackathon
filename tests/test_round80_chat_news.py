"""Relative HVAC evidence and date/deadline-gated news; no export writes."""
from datetime import datetime,timedelta,timezone
from email.utils import format_datetime
import time
import httpx
import pytest
from src.agent import web_search as w
from src.agent.chat import answer
from src.agent.chat_engine import consume
from src.agent.chat_tools import execute
from src.agent.chat_evidence import compact_evidence,required_items
from src.agent.chat_sentence_stream import safe_sentence,host_supplement
from src.agent.display_text import display_evidence
from src.data.replay_payload import load_replay

QUESTIONS=['把空调调低一度会怎样','空调设定降低1度，电费和峰值有什么变化','空调降温一度要多花多少钱','把空调温度下调一度呢']
SIMILAR=QUESTIONS+['帮我查一下空调调低一度会怎样']

@pytest.mark.parametrize('question',SIMILAR)
def test_relative_hvac_reads_current_setpoint_not_household_or_general(monkeypatch,question):
    monkeypatch.setenv('LLM_MODE','demo')
    monkeypatch.setattr(w,'search',lambda *a,**kw:pytest.fail('building evidence only'))
    d=load_replay('normal');row=d['hours'][14];r=answer(question,d,row)
    c=r['tool_trace'][-1]['result']
    assert r['known'] and r['grounded'] and r['tool_trace'][-1]['tool']=='compare_costs'
    assert c['before_setpoint_c']==row['agent']['hvac_setpoint_c']
    assert c['after_setpoint_c']==round(c['before_setpoint_c']-1,1)
    assert c['extra_cost_cny']>0 and c['after_peak_kw']>c['before_peak_kw']
    assert '预计多花' in r['answer'] and '电网峰值' in r['answer']
    assert not any(w in r['answer'] for w in ('单台','几毛钱','6%','10%','家用'))
    assert [t['tool'] for t in r['tool_trace']].count('compare_costs')==1


def test_relative_hvac_uses_other_origin_and_never_clamps_invalid_request(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo')
    d=load_replay('normal');row=d['hours'][14]
    # Copy only for input-boundary test, never change saved export/control.
    import copy
    row=copy.deepcopy(row);row['agent']['hvac_setpoint_c']=26.0
    r=consume(execute('hvac_compare',QUESTIONS[0],d,row))
    assert r['tool_trace'][-1]['result']['after_setpoint_c']==25.0
    row['agent']['hvac_setpoint_c']=24.0
    r=consume(execute('hvac_compare',QUESTIONS[0],d,row))
    assert not r['known'] and '未调整设备' in r['answer']
    assert not any(t['tool'].startswith('simulate_schedule') for t in r['tool_trace'])


def test_peak_delta_sourced_from_full_precision_not_rounded_endpoints():
    d=load_replay('normal');row=d['hours'][14]
    r=consume(execute('hvac_compare',QUESTIONS[0],d,row))
    c=r['tool_trace'][-1]['result']
    before=next(t['result'] for t in r['tool_trace'] if t['tool']=='simulate_schedule_before')
    after=next(t['result'] for t in r['tool_trace'] if t['tool']=='simulate_schedule_after')
    assert c['peak_increase_kw']==round(after['estimated_peak_kw']-before['estimated_peak_kw'],1)
    evidence=display_evidence(compact_evidence(r['tool_trace']),row['t'],row)
    assert safe_sentence(f"电网峰值增加 {c['peak_increase_kw']} kW。",'hvac_compare',r,row,evidence)
    assert not safe_sentence(f"电网峰值降低 {c['peak_increase_kw']} kW。",'hvac_compare',r,row,evidence)
    required=required_items(r)
    missing=[i for i in required if i['field'] in ('before_peak_kw','after_peak_kw','peak_increase_kw')]
    assert len(missing)==3
    assert '电网峰值增加' in host_supplement('hvac_compare',r,missing,False,'已有说明。')


def test_relative_increase_temperature_peak_reduction_grounded(monkeypatch):
    monkeypatch.setenv('LLM_MODE','demo');d=load_replay('normal');row=d['hours'][14]
    r=consume(execute('hvac_compare','空调调高一度会怎样',d,row))
    c=r['tool_trace'][-1]['result']
    assert c['savings_cny']>0 and c['peak_reduction_kw']>0
    assert '预计可节省' in r['answer'] and '降低' in r['answer']
    assert any(i['field']=='peak_reduction_kw' for i in required_items(r))


def rss(items):
    return '<rss><channel>'+''.join('<item><title>北京天气 '+name+'</title><link>https://example.org/'+name+'</link><description>北京天气</description>'+('<pubDate>'+stamp+'</pubDate>' if stamp else '')+'</item>' for name,stamp in items)+'</channel></rss>'


def test_recent_news_filters_old_missing_invalid_future_on_primary_and_fallback(monkeypatch):
    now=datetime(2026,10,12,8,tzinfo=timezone.utc);monkeypatch.setattr(w,'utc_now',lambda:now)
    entries=[('today',format_datetime(now-timedelta(hours=1))),('boundary',format_datetime(now-timedelta(days=14))),
        ('expired',format_datetime(now-timedelta(days=14,seconds=1))),('june','Mon, 01 Jun 2026 00:00:00 GMT'),
        ('missing',''),('invalid','junk'),('future',format_datetime(now+timedelta(seconds=1)))]
    for news,recent in [(True,False),(False,True)]:
        with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,text=rss(entries)))) as client:
            sources=w.bing_sources('北京天气新闻',client,news=news,recent=recent)
        assert [s['url'].rsplit('/',1)[-1] for s in sources]==['today','boundary']
        assert all('published_at' in s for s in sources)


def test_empty_news_native_tool_does_not_invent_events(monkeypatch):
    from tests.test_public_native_search import Native,call
    from src.agent.general_chat import events,NO_PUBLIC_EVIDENCE
    monkeypatch.setattr(w,'search',lambda *a,**kw:dict(status='empty',sources=[]))
    model=Native([call('北京近期天气报道'),{'content':'今天没有天气事件发生。'}])
    r=consume(events('北京最近有什么天气新闻',model))
    assert r['answer']==NO_PUBLIC_EVIDENCE and not r['known']
    assert r['llm_called'] and len(r['tool_trace'])==1


def test_search_deadline_is_total_before_any_unverified_sse(monkeypatch):
    import threading
    from tests.test_public_native_search import Native,call,collect
    from src.agent.general_chat import events,NO_PUBLIC_EVIDENCE
    original=w.search;release=threading.Event()
    def handler(request):
        release.wait(.5)
        raise httpx.ReadTimeout('private-not-for-output')
    def bounded(q,**kw):
        kw['seconds']=.03
        return original(q,client_factory=lambda **opts:httpx.Client(transport=httpx.MockTransport(handler),**opts),**kw)
    monkeypatch.setattr(w,'search',bounded)
    model=Native([call('北京天气新闻'),{'content':'尚未发生。'}])
    began=time.monotonic()
    try:
        r,seen=collect(events('北京最近有什么天气新闻',model))
        assert time.monotonic()-began<.3
        assert r['answer']==NO_PUBLIC_EVIDENCE
        assert ''.join(e.get('text','') for e in seen if e['type']=='answer_delta')==NO_PUBLIC_EVIDENCE
    finally:release.set()


def test_news_body_and_dates_go_to_model_not_keyword_template(monkeypatch):
    from tests.test_public_native_search import Native,call
    from src.agent.general_chat import events
    source=dict(title='北京天气今日报道',url='https://example.org/today',
                snippet='发布时间：2026-10-13',body='2026-10-13北京气象测试报道')
    monkeypatch.setattr(w,'search',lambda *a,**kw:dict(status='ok',sources=[source]))
    model=Native([call('北京天气2026-10-13'),{'content':'报道日期为2026年10月13日。'}])
    r=consume(events('北京最近有什么天气新闻',model))
    assert '2026-10-13北京气象测试报道' in model.requests[1][0][-1]['content']
    assert r['answer'].count(source['url'])==1 and r['llm_called']
