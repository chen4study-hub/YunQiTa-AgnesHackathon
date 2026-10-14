import pytest
from src.agent.chat_engine import consume
from src.agent.chat_router import route_events
from src.agent import web_search


class General:
    def chat_call(self,phase,payload,feedback=''):
        if phase=='route':return {'result':{'choices':[{'tool':'general_chat','parameters':{}}]},'llm':{'mode':'real','reason':'call_succeeded'}}
        assert phase=='general'
        return {'result':{'answer':'这是常识回答：1900 年、50% 都可以正常解释；本楼真实数据需查询工具。'},'llm':{'mode':'real','reason':'call_succeeded'}}


@pytest.mark.parametrize('question',['你好','什么是光合作用','解释一下复利','楼宇运维基础知识','电梯工作原理','电池SOC是什么意思'])
def test_general_numbers_not_checked_against_building(monkeypatch,question):
    monkeypatch.setenv('LLM_MODE','real')
    monkeypatch.setattr('src.agent.chat_engine.get_llm_status',lambda:{'mode':'real'})
    r=consume(route_events(question,{}, {},General()))
    assert r['known'] and r['explanation_source']=='llm' and '1900 年、50.0%' in r['answer']
    assert r['reason']=='answered' and not r['needs_human']
    assert not any(t['tool']=='data_availability' for t in r['tool_trace'])


def test_model_search_for_public_ops_knowledge_not_building_reading(monkeypatch):
    from tests.test_public_native_search import Native,call
    calls=[]
    monkeypatch.setattr(web_search,'search',lambda q,**kw:calls.append(q) or {
        'status':'ok','sources':[{'title':'甲','url':'https://example.org/a','snippet':'运维知识'},
                               {'title':'乙','url':'https://example.org/a','snippet':'更多知识'}]})
    model=Native([call('楼宇运维基础知识'),{'content':'这是公开运维知识。'}])
    r=consume(route_events('联网查询5个楼宇运维的基础知识点',{}, {},model))
    assert calls and r['known'] and r['answer'].count('https://example.org/a')==1
    assert r['tool_trace'][0]['tool']=='web_search'


def test_failed_web_reports_cannot_confirm_not_scope_refusal(monkeypatch):
    from tests.test_public_native_search import Native,call
    from src.agent.general_chat import NO_PUBLIC_EVIDENCE
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:{'status':'unavailable','sources':[]})
    model=Native([call('楼宇运维常识'),{'content':'没有查到。'}])
    r=consume(route_events('搜索楼宇运维常识',{}, {},model))
    assert not r['known'] and r['answer']==NO_PUBLIC_EVIDENCE and r['reason']=='answered'


def test_public_wait_budget_and_markdown_preserved(monkeypatch):
    from src.agent import general_chat
    import time
    assert general_chat.FIRST_TOKEN_SECONDS==15.
    # Scale 15 seconds to .15 seconds; first token arrives later than scaled 8s.
    monkeypatch.setattr(general_chat,'FIRST_TOKEN_SECONDS',.15)
    class Late:
        def chat_stream(self,payload):
            time.sleep(.1)
            yield {'type':'text_delta','text':'常识回答含 Markdown：**碳中和**是净零排放。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    r=consume(general_chat.events('什么是碳中和',Late()))
    assert r['known'] and '**碳中和**' in r['answer']


def test_public_true_timeout_short_message(monkeypatch):
    from src.agent import general_chat
    import time
    monkeypatch.setattr(general_chat,'FIRST_TOKEN_SECONDS',.03)
    class Slow:
        def chat_stream(self,payload):
            time.sleep(.2)
            yield {'type':'text_delta','text':'迟到的内容。'}
    r=consume(general_chat.events('闲聊',Slow()))
    assert r['answer']=='这次回答超时了，可以再问一次' and not r['needs_human']


@pytest.mark.parametrize('streaming',[False,True])
def test_internal_citation_words_never_emitted_in_json_or_sse(monkeypatch,streaming):
    from src.agent import general_chat
    url='https://example.org/verified'
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:dict(status='ok',sources=[dict(title='真实标题',url=url)]))
    raw='这是公开资料中的内容。来源链接请参考宿主附上的公开资料。还请留意发布时间。'
    class Fake:
        def chat_call(self,*a,**kw):return dict(result=dict(answer=raw),llm=dict(mode='real',reason='call_succeeded'))
    class Stream:
        def chat_stream(self,*a,**kw):
            yield dict(type='text_delta',text='这是公开资料中的内容。来源链接请参')
            yield dict(type='text_delta',text='考宿主附上的公开资料。还请留意发布时间。')
            yield dict(type='done',llm=dict(mode='real',reason='call_succeeded'))
    g=general_chat.events('给出来源链接',Stream() if streaming else Fake(),web=True);events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:r=end.value;break
    emitted=''.join(e.get('text','') for e in events)
    assert '宿主' not in r['answer'] and '宿主' not in emitted
    assert '来源链接请参考' not in r['answer'] and '公开资料中的内容' in r['answer']
    assert r['answer'].count(url)==1


def test_stroll_reads_local_weather_no_building_data_step_or_other_app(monkeypatch):
    from src.data.replay_payload import load_replay
    class Fake:
        def chat_call(self,*a,**kw):pytest.fail('weather advice is directly grounded')
    d=load_replay('normal');g=route_events('今天适合出去散步吗',d,d['hours'][14],Fake());events=[]
    while True:
        try:events.append(next(g))
        except StopIteration as end:r=end.value;break
    assert r['tool_trace'][0]['tool']=='get_weather' and r['known']
    assert '13.3 °C' in r['answer'] and '57.0%' in r['answer'] and '散步' in r['answer']
    assert '应用' not in r['answer'] and '宿主' not in r['answer']
    assert [e['text'] for e in events if e['type']=='step']==['正在查看天气…']


def test_public_prompts_no_internal_citation_instructions():
    from pathlib import Path
    code=Path('src/agent/provider.py').read_text(encoding='utf-8')
    assert '链接由宿主附上' not in code and '来源链接由宿主附上' not in code
    assert '不生成网址、来源段落或链接说明' in code


def test_public_postprocess_preserves_markdown_lines_and_no_duplicate_source_heading():
    from src.agent.general_chat import public_answer_text
    text='重点如下：\n1. **第一条**\n2. **第二条**\n**来源**：\n宿主附上资料。'
    cleaned=public_answer_text(text)
    assert '重点如下：\n1. **第一条**\n2. **第二条**\n' in cleaned
    assert '宿主' not in cleaned and '**来源**' not in cleaned


def test_public_stream_final_cleanup_never_loses_sources_after_newline(monkeypatch):
    from src.agent.general_chat import events
    url='https://api.nobelprize.org/2/nobelPrize/phy/2024'
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:dict(status='ok',sources=[dict(title='2024 年物理学奖',url=url)]))
    class Fake:
        def chat_stream(self,payload):
            yield dict(type='text_delta',text='物理学奖资料如下。\n\n**来源**：\n宿主附上。')
            yield dict(type='done',llm=dict(reason='call_succeeded'))
    g=events('2024年物理学奖',Fake(),web=True);collected=[]
    while True:
        try:collected.append(next(g))
        except StopIteration as end:r=end.value;break
    text=''.join(e['text'] for e in collected if e['type']=='answer_delta')
    assert text==r['answer'] and text.count(url)==1
    assert '宿主' not in text


@pytest.mark.parametrize('stream',[False,True])
@pytest.mark.parametrize('web',[False,True])
def test_public_numeric_disclaimer_is_not_a_building_measurement(monkeypatch,stream,web):
    from src.agent.general_chat import events
    monkeypatch.setattr(web_search,'search',lambda *a,**kw:{'status':'unavailable','sources':[]})
    class Call:
        def chat_call(self,*a):
            return {'result':{'answer':'复利例子中本金增长 50%；本楼真实数据需查询工具。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    class Stream(Call):
        def chat_stream(self,*a):
            yield {'type':'text_delta','text':'复利例子中本金增长 50%；本楼真实数据需查询工具。'}
            yield {'type':'done','llm':{'mode':'real','reason':'call_succeeded'}}
    g=events('解释一下复利',Stream() if stream else Call(),web=web);emitted=[]
    while True:
        try:emitted.append(next(g))
        except StopIteration as end:out=end.value;break
    if web:
        from src.agent.general_chat import NO_PUBLIC_EVIDENCE
        assert not out['known'] and out['answer']==NO_PUBLIC_EVIDENCE
    else:
        assert out['known'] and out['explanation_source']=='llm'
        assert '50.0%' in out['answer']
    assert ''.join(e['text'] for e in emitted if e['type']=='answer_delta')==out['answer']



@pytest.mark.parametrize('text',[
    '本楼储能；功率 50 kW。','本楼储能，功率 50 kW。',
    '本楼真实数据需查询工具；当前储能电量为 50%。',
    '本楼真实数据为 50%，需查询工具。'])
def test_numeric_disclaimer_exception_never_allows_local_claims(text):
    from src.agent.general_chat import public_numeric_safe
    assert not public_numeric_safe(text,'说一句常识')
    assert not public_numeric_safe('复利收益 50%；本楼真实数据需查询工具。','本楼电费多少')
