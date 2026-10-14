"""Isolated admission control and cancellable sync-to-async event bridge."""
import asyncio
import contextlib
import threading
import json
from concurrent.futures import ThreadPoolExecutor
import anyio
from fastapi import HTTPException


class WorkPool:
    """No waiting admission queue; identical in-flight calls share one result."""
    def __init__(self, size=4):
        self.limiter=anyio.CapacityLimiter(size)
        self.executor=ThreadPoolExecutor(max_workers=size,thread_name_prefix='schedule')
        self.running={}

    async def run(self,key,fn):
        # Canonical JSON treats reordered constraint keys as the same parameters.
        if isinstance(key,tuple) and isinstance(key[-1],str):
            try:key=(*key[:-1],json.dumps(json.loads(key[-1]),sort_keys=True,separators=(',',':')))
            except ValueError:pass
        # No await between lookup/admission/registration: atomic on the event loop.
        shared=self.running.get(key)
        if shared is not None:return await asyncio.shield(shared)
        borrower=object()
        try:self.limiter.acquire_on_behalf_of_nowait(borrower)
        except anyio.WouldBlock:raise HTTPException(503,'调度服务繁忙，请稍后再试。')
        loop=asyncio.get_running_loop()
        try:future=loop.run_in_executor(self.executor,fn)
        except BaseException:
            self.limiter.release_on_behalf_of(borrower);raise
        self.running[key]=future
        def finished(f):
            if self.running.get(key) is f:self.running.pop(key,None)
            self.limiter.release_on_behalf_of(borrower)
            # Retrieve exceptions even when every client has disconnected.
            if not f.cancelled():f.exception()
        future.add_done_callback(finished)
        # Disconnect cannot cancel an already dispatching shared transaction.
        return await asyncio.shield(future)


class ChatPool:
    def __init__(self,size=4):
        self.limiter=anyio.CapacityLimiter(size)
        self.executor=ThreadPoolExecutor(max_workers=size,thread_name_prefix='chat')

    async def events(self,load,make_pipeline,provider):
        borrower=object()
        try:self.limiter.acquire_on_behalf_of_nowait(borrower)
        except anyio.WouldBlock:
            yield {'type':'error','message':'问答服务繁忙，请稍后再试。'}
            yield {'type':'done','known':False,'needs_human':False,'grounded':True,'reason':'no_data'}
            return
        loop=asyncio.get_running_loop();box=asyncio.Queue(maxsize=16);stop=threading.Event()
        def put(item):
            if stop.is_set():return
            try:
                future=asyncio.run_coroutine_threadsafe(box.put(item),loop)
                while not stop.is_set():
                    try:future.result(timeout=.1);return
                    except TimeoutError:pass
                future.cancel()
            except (RuntimeError,asyncio.CancelledError):pass
        def work():
            pipeline=None
            try:
                data,row=load();pipeline=make_pipeline(data,row,provider)
                # The route owns all steps; preserve its first event as well.
                for event in pipeline:
                    if stop.is_set():break
                    put(event)
            except Exception:
                put({'type':'error','message':'起报记录或工具数据不可用。'})
                put({'type':'done','known':False,'needs_human':False,'grounded':True,'reason':'no_data'})
            finally:
                if pipeline is not None:pipeline.close()
                put(None)
        future=loop.run_in_executor(self.executor,work)
        def finished(f):
            self.limiter.release_on_behalf_of(borrower)
            if not f.cancelled():f.exception()
        future.add_done_callback(finished)
        try:
            while True:
                event=await box.get()
                if event is None:break
                yield event
        finally:
            stop.set()
            # Close the upstream socket independently of the occupied chat worker.
            if hasattr(provider,'cancel_chat'):provider.cancel_chat()
            with contextlib.suppress(asyncio.TimeoutError,asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(future),.5)


schedule_pool=WorkPool()
chat_pool=ChatPool()
