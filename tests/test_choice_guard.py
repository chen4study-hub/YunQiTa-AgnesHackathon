import threading,time
from types import SimpleNamespace
import httpx
import pytest
from src.agent import choice_guard as g,provider as p

FALLBACK={'choice':{'candidate_id':'rule_hold','reason':'保持设定。'},'llm':{'mode':'rule'}}


def test_hard_deadline_no_second_budget(monkeypatch):
    monkeypatch.setattr(g,'BUDGET_SECONDS',.05);monkeypatch.setattr(g,'CIRCUIT',g.Circuit())
    gate=threading.Event();closed=threading.Event();obj=SimpleNamespace(_choice_client=SimpleNamespace(close=closed.set))
    def work(left,cancel):gate.wait(.5);return FALLBACK
    start=time.monotonic()
    try:
        out=g.bounded_choice(obj,work,FALLBACK)
        assert time.monotonic()-start<.2 and out['llm']['fallback_reason']=='choice_deadline'
        assert g.bounded_choice(obj,lambda *a:pytest.fail('no retry'),FALLBACK)['llm']['fallback_reason']=='choice_deadline'
        assert closed.wait(.2)
    finally:gate.set()


def test_circuit_three_failures_and_one_half_open_probe():
    clock=[0.];c=g.Circuit(clock=lambda:clock[0])
    for _ in range(3):assert c.allow();c.record(False)
    assert not c.allow();clock[0]=91
    assert c.allow() and not c.allow();c.record(True);assert c.allow()
    for _ in range(3):assert c.allow();c.record(False)
    clock[0]=182;assert c.allow();c.record(False);assert not c.allow()


@pytest.mark.parametrize('failure',['timeout','500'])
def test_choose_candidate_failure_never_retries_and_no_secret(monkeypatch,failure,caplog):
    monkeypatch.setattr(g,'CIRCUIT',g.Circuit())
    monkeypatch.setattr(p,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(p,'read_key',lambda:('private-test-credential','available'))
    calls=[]
    class Client:
        def __init__(self,**kw):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def post(self,*a,**kw):
            calls.append(1)
            if failure=='timeout':raise httpx.ReadTimeout('private-test-credential')
            r=httpx.Response(500,request=httpx.Request('POST','https://example.test'));r.raise_for_status()
    monkeypatch.setattr(p.httpx,'Client',Client)
    obj=p.OpenAICompatibleProvider();f={'predictions':[{'upper':100.}]};c=[{'candidate_id':'rule_hold'}]
    result=obj.choose_candidate(f,c,'test')
    assert len(calls)==1 and result['llm']['reason']=='call_failed'
    obj.choose_candidate(f,c,'test');assert len(calls)==1
    assert 'private-test-credential' not in str(result)+caplog.text


def test_busy_does_not_spawn_more_threads(monkeypatch):
    sem=threading.BoundedSemaphore(1);monkeypatch.setattr(g,'SLOTS',sem);sem.acquire()
    try:assert g.bounded_choice(SimpleNamespace(),lambda *a:pytest.fail('busy'),FALLBACK)['llm']['fallback_reason']=='choice_busy'
    finally:sem.release()
