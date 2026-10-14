import asyncio
import inspect
import json
import threading
import time
from functools import partial
import httpx
from src.api import app as api
from src.api.async_runtime import WorkPool,ChatPool


def test_health_and_stream_are_async_and_health_does_not_read(monkeypatch):
    assert inspect.iscoroutinefunction(api.health)
    assert inspect.iscoroutinefunction(api.schedule)
    assert inspect.iscoroutinefunction(api.explain)
    assert inspect.iscoroutinefunction(api.chat_stream)
    monkeypatch.setattr(api,'ready',lambda:(_ for _ in ()).throw(AssertionError('disk')))
    monkeypatch.setattr(api,'get_llm_status',lambda:(_ for _ in ()).throw(AssertionError('key')))
    assert asyncio.run(api.health())['status']=='ok'


def test_45_stalled_schedules_keep_health_under_one_second(monkeypatch):
    gate=threading.Event();entered=[]
    pool=WorkPool(4);monkeypatch.setattr(api,'schedule_pool',pool)
    from src.data.replay_payload import load_replay
    data=load_replay('normal');row=data['hours'][14]
    monkeypatch.setattr(api,'replay_hour',lambda *a:(data,row))
    monkeypatch.setenv('LLM_MODE','demo')
    def stalled(request,dispatch):
        entered.append(request.building_id);gate.wait(5)
        return {'building_id':request.building_id}
    monkeypatch.setattr(api,'agent_schedule',stalled)
    async def probe():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app),base_url='http://test') as client:
            def body(i):return {'building_id':str(i),'start':'2026-10-12T00:00:00Z','end':'2026-10-12T01:00:00Z'}
            pending=[asyncio.create_task(client.post('/schedule',json=body(i))) for i in range(45)]
            for _ in range(100):
                if len(entered)==4:break
                await asyncio.sleep(.01)
            start=time.monotonic();health=await client.get('/health');elapsed=time.monotonic()-start
            assert health.status_code==200 and elapsed<1
            # A genuine building-read SSE step bypasses the scheduler pool.
            request=api.ChatRequest(question='今天有哪些告警',origin='2026-10-12T00:00:00Z')
            stream=await api.chat_stream(request);iterator=stream.body_iterator
            start=time.monotonic();first=await anext(iterator)
            # 72f8c2b: actual tool boundary replaces generic query narration.
            assert '"type":"tool_start"' in first and time.monotonic()-start<1
            await iterator.aclose()
            gate.set();results=await asyncio.gather(*pending)
            assert sum(r.status_code==200 for r in results)==4
            assert sum(r.status_code==503 for r in results)==41
    try:asyncio.run(probe())
    finally:gate.set();pool.executor.shutdown(wait=True)


def test_shared_schedule_runs_once_and_cancelled_waiter_does_not_free_slot():
    pool=WorkPool(1);gate=threading.Event();calls=[]
    def work():calls.append(1);gate.wait(2);return 42
    async def probe():
        first=asyncio.create_task(pool.run('same',work));await asyncio.sleep(.02)
        second=asyncio.create_task(pool.run('same',work));await asyncio.sleep(.02)
        first.cancel()
        try:await first
        except asyncio.CancelledError:pass
        assert pool.limiter.borrowed_tokens==1
        gate.set();assert await second==42
        await asyncio.sleep(0);assert pool.limiter.borrowed_tokens==0 and len(calls)==1
    try:asyncio.run(probe())
    finally:gate.set();pool.executor.shutdown(wait=True)


def test_disconnect_closes_upstream_and_releases_chat_slot():
    pool=ChatPool(1);gate=threading.Event();closed=threading.Event()
    class Provider:
        def cancel_chat(self):closed.set();gate.set()
    def pipeline(data,row,provider):
        try:
            yield {'type':'step'};yield {'type':'tool_start','tool':'current_energy','args':{}}
            gate.wait(2);yield {'type':'done'}
        finally:closed.set()
    async def probe():
        stream=pool.events(lambda:({},{}),pipeline,Provider())
        assert (await anext(stream))['type']=='step'
        assert (await anext(stream))['type']=='tool_start'
        await stream.aclose();await asyncio.sleep(.05)
        assert closed.is_set() and pool.limiter.borrowed_tokens==0
    try:asyncio.run(probe())
    finally:gate.set();pool.executor.shutdown(wait=True)


def test_stream_disconnect_cancels_real_upstream_and_sentence_slot(monkeypatch):
    from src.agent import chat_sentence_stream as sentences,chat_engine,provider as upstream
    from src.agent.chat_engine import events
    from src.data.replay_payload import load_replay
    gate=threading.Event();opened=threading.Event();closed=threading.Event()
    class Response:
        def __enter__(self):opened.set();return self
        def __exit__(self,*a):pass
        def raise_for_status(self):pass
        def iter_lines(self):
            gate.wait(4)
            if False:yield ''
    class Client:
        def __init__(self,**kw):pass
        def __enter__(self):return self
        def __exit__(self,*a):self.close()
        def close(self):closed.set();gate.set()
        def stream(self,*a,**kw):return Response()
    monkeypatch.setattr(upstream,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(chat_engine,'get_llm_status',lambda:{'mode':'real'})
    monkeypatch.setattr(upstream,'read_key',lambda:('test-placeholder','available'))
    monkeypatch.setattr(upstream.httpx,'Client',Client)
    data=load_replay('normal');row=data['hours'][14];pool=ChatPool(1)
    def make(d,r,p):return events('执行回执是什么',d,r,p)
    async def probe():
        stream=pool.events(lambda:(data,row),make,upstream.OpenAICompatibleProvider())
        while not opened.is_set():
            task=asyncio.create_task(anext(stream))
            await asyncio.sleep(.05)
            if opened.is_set():
                task.cancel()
                try:await task
                except (asyncio.CancelledError,StopAsyncIteration):pass
                break
            await task
        await stream.aclose();await asyncio.sleep(.2)
        assert closed.is_set() and pool.limiter.borrowed_tokens==0
        assert sentences.SLOTS.acquire(blocking=False);sentences.SLOTS.release()
    try:asyncio.run(probe())
    finally:gate.set();pool.executor.shutdown(wait=True)
