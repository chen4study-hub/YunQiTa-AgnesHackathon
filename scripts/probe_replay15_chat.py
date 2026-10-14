"""Owned-port 1.5 HTTP chat/stream smoke; process-only rule mode, no LLM calls."""
import json,os,socket,subprocess,sys,time
from pathlib import Path
import httpx


def main():
    root=Path('exports/replay');main=json.loads((root/'normal.json').read_text(encoding='utf-8'));row=main['hours'][14]
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env=dict(os.environ);env['LLM_MODE']='demo'
    child=subprocess.Popen([sys.executable,'-m','uvicorn','src.api.app:app','--host','127.0.0.1','--port',str(port),'--no-access-log'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    results=[]
    try:
        with httpx.Client(timeout=15,trust_env=False) as client:
            base=f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    if client.get(base+'/health').status_code==200:break
                except httpx.HTTPError:pass
                time.sleep(.1)
            else:raise RuntimeError('owned backend startup failed')
            served=client.get(base+'/replay/normal');served.raise_for_status()
            assert served.json()['schema_version']=='1.5'
            for q in ['现在几点','今天几号','天气怎么样','现在储能电量多少','为什么这样调度','执行回执是什么','明天最高负荷','未来天气怎么样','空调改26度电费多少','当前光伏和储能功率是多少']:
                request={'scenario':'normal','origin':row['t'],'question':q,'display_date':'2026-10-12','display_time':'13:44'}
                started=time.monotonic()
                response=client.post(base+'/chat',json=request);response.raise_for_status();out=response.json()
                elapsed_ms=round((time.monotonic()-started)*1000,1)
                if q in ('现在几点','今天几号','天气怎么样'):assert elapsed_ms<1000
                assert out['known'] and out['grounded'] and not out['llm_called']
                sse=client.post(base+'/chat/stream',json=request);sse.raise_for_status()
                events=[json.loads(line[6:]) for line in sse.text.splitlines() if line.startswith('data: ')]
                assert not any(e['type']=='error' for e in events)
                assert events[-1]['type']=='done' and events[-1]['grounded']
                assert ''.join(e['text'] for e in events if e['type']=='answer_delta')==out['answer']
                if q=='现在储能电量多少':assert '空调' not in out['answer'] and '设定' not in out['answer']
                if q=='明天最高负荷':assert '明天 13:00' in out['answer'] and '次日' not in out['answer'] and '不代表' not in out['answer']
                if q=='执行回执是什么':assert ' BA/EMS 下发日志回执' in out['answer'] and '不是实物' not in out['answer']
                if q=='为什么这样调度':assert all(w in out['answer'] for w in ('全额调度','2,234.5 元','1,179.9 kW'))
                if q=='空调改26度电费多少':assert all(w not in out['answer'] for w in ('接受时段','门控阈值','非全天收益','需人工核对'))
                results.append({'question':q,'known':out['known'],'grounded':out['grounded'],'answer':out['answer'],
                    'tool_names':[t['tool'] for t in out['tool_trace']],'llm_called':out['llm_called'],'json_sse_equal':True,'elapsed_ms':elapsed_ms})
    finally:
        child.terminate()
        try:child.wait(timeout=10)
        except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
    receipt={'status':'passed','schema_version':'1.5','owned_port':port,'resident_unchanged':True,'owned_process_stopped':True,'new_llm_calls':0,'results':results}
    Path('experiments/replay15_chat_probe.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','questions':len(results),'owned_process_stopped':True,'new_llm_calls':0}))


if __name__=='__main__':main()
