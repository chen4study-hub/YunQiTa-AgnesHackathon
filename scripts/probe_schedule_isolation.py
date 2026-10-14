"""Owned HTTP server with an intentionally stuck upstream; never touch port 8000."""
import asyncio,json,os,socket,subprocess,sys,time
from pathlib import Path
import httpx

CHILD = r"""
import threading,httpx,uvicorn
from src.api import app as api
from src.agent import provider
provider.get_llm_status=lambda:{'mode':'real','reason':'test_stalled_upstream'}
provider.read_key=lambda:('test-placeholder','available')
class StuckClient:
    def __init__(self,**kw):self.closed=threading.Event()
    def __enter__(self):return self
    def __exit__(self,*a):self.close()
    def close(self):self.closed.set()
    def post(self,*a,**kw):
        self.closed.wait(60)
        raise httpx.ReadTimeout('test upstream stalled')
provider.httpx.Client=StuckClient
uvicorn.run(api.app,host='127.0.0.1',port=PORT,access_log=True,log_config='configs/backend_logging.json')
"""


async def probe(base,request):
    async with httpx.AsyncClient(timeout=25,trust_env=False) as c:
        started=time.monotonic()
        tasks=[asyncio.create_task(c.post(base+'/schedule',json={**request,'constraints':{'peak_target_kw':800+i}})) for i in range(45)]
        await asyncio.sleep(.4)
        health_times=[]
        for _ in range(3):
            t=time.monotonic();r=await c.get(base+'/health');health_times.append(round((time.monotonic()-t)*1000,1));assert r.status_code==200
            await asyncio.sleep(.1)
        async with c.stream('POST',base+'/chat/stream',json={'scenario':'normal','origin':request['start'],'question':'今天用了多少电'}) as r:
            t=time.monotonic()
            async for line in r.aiter_lines():
                if line.startswith('data: '):
                    first=json.loads(line[6:]);step_ms=round((time.monotonic()-t)*1000,1);break
            assert first['type']=='step'
        replies=await asyncio.gather(*tasks)
        statuses={str(code):sum(r.status_code==code for r in replies) for code in (200,503)}
        assert statuses=={'200':4,'503':41},statuses
        assert max(health_times)<1000 and step_ms<1000
        assert all(r.json()['llm']['reason']=='call_failed' for r in replies if r.status_code==200)
        return {'status':'passed','requests':45,'status_counts':statuses,'health_ms':health_times,
            'first_step_ms':step_ms,'all_requests_seconds':round(time.monotonic()-started,2),'upstream':'blocks until host closes client','choice_budget_seconds':15}


def main():
    d=json.loads(Path('exports/replay/normal.json').read_text(encoding='utf-8'));start=d['hours'][14]['t']
    from datetime import datetime,timedelta
    request={'building_id':d['meta']['building_id'],'scenario':'normal','start':start,'end':(datetime.fromisoformat(start)+timedelta(hours=1)).isoformat()}
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env=dict(os.environ,LLM_MODE='demo',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
    # Dispatch records from the test go only to a disposable directory.
    import tempfile
    with tempfile.TemporaryDirectory() as temp:
        code=CHILD.replace('PORT',str(port)).replace("provider.httpx.Client=StuckClient", "provider.httpx.Client=StuckClient\napi.ROOT=__import__('pathlib').Path("+repr(temp)+")\napi.replay_scenario=lambda s:__import__('json').loads(__import__('pathlib').Path("+repr(str(Path('exports/replay').resolve()))+").joinpath(s+'.json').read_text(encoding='utf-8'))")
        # Lazy detail loader must keep its workspace root; only API dispatch path changes.
        child=subprocess.Popen([sys.executable,'-c',code],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            base=f'http://127.0.0.1:{port}'
            with httpx.Client(timeout=1,trust_env=False) as c:
                for _ in range(150):
                    try:
                        if c.get(base+'/health').status_code==200:break
                    except httpx.HTTPError:pass
                    time.sleep(.1)
                else:raise RuntimeError('owned server startup failed')
            result=asyncio.run(probe(base,request))
        finally:
            child.terminate()
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
    result.update(owned_port=port,owned_process_stopped=child.poll() is not None,resident_changed=False)
    Path('experiments/schedule_isolation_probe.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':main()
