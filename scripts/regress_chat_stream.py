"""Real-mode six-question local wire regression; receipt only, no body/answer/key logs."""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from scripts.serve_backend import ROOT,LOGS
import argparse

PORT=8001
QUESTIONS=['为什么这样调度','为什么转人工','执行回执是什么','现在储能SOC多少','未来24小时峰值在几点、多少kW','空调改26度能省多少电费']


def request(path,payload):
    return urllib.request.Request(f'http://127.0.0.1:{PORT}'+path,data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})


def main():
    global PORT
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8001)
    parser.add_argument('--output',default='experiments/chat_stream_real_regression.json')
    args=parser.parse_args();PORT=args.port
    # Refuse takeover of anyone's running backend.
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health',timeout=1):pass
    except Exception:pass
    else:raise RuntimeError('Port8000 already served; stop/restart consciously before managed regression')
    log=(LOGS/'chat_stream_uvicorn.log').open('a',encoding='utf-8')
    owned=subprocess.Popen([sys.executable,'-m','uvicorn','src.api.app:app','--host','127.0.0.1','--port',str(PORT),'--no-access-log'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT);receipt={'rows':[],'port':PORT}
    try:
        for _ in range(60):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health',timeout=1) as r:health=json.load(r)
                break
            except Exception:time.sleep(.5)
        else:raise RuntimeError('Regression backend not ready')
        assert health['llm']['mode']=='real';receipt['health_llm_mode']='real'
        for i,q in enumerate(QUESTIONS):
            payload={'question':q,'scenario':'normal','origin':'2017-10-23T14:00:00-05:00'};start=time.monotonic()
            with urllib.request.urlopen(request('/chat/stream',payload),timeout=20) as r:
                first=json.loads(r.readline().decode().removeprefix('data: '));latency=time.monotonic()-start
                events=[first]
                for line in r:
                    if line.strip():events.append(json.loads(line.decode().removeprefix('data: ')))
            elapsed=time.monotonic()-start;types=[e['type'] for e in events];done=events[-1]
            assert latency<1 and first['type']=='step' and done['type']=='done'
            assert set(done)=={'type','known','needs_human','grounded'} and done['grounded']
            assert types.index('tool_start')<types.index('tool_end')<types.index('answer_delta')<types.index('done')
            if i<5:assert done['known'] and not done['needs_human']
            else:assert done['known'] and done['needs_human'] # accepted-only comparison, rejected hours explicitly excluded
            assert elapsed<15
            start=time.monotonic()
            with urllib.request.urlopen(request('/chat',payload),timeout=20) as r:out=json.load(r)
            json_ms=round((time.monotonic()-start)*1000,1)
            assert json_ms<15000
            assert out['llm_called'] and out['known']==done['known'] and out['needs_human']==done['needs_human'] and out['grounded']
            if i==5:
                compare=out['tool_trace'][-1]['result'];assert 0<compare['accepted_hours']<24
                assert compare['accepted_hours']+compare['excluded_hours']==24
                stream_text=''.join(e['text'] for e in events if e['type']=='answer_delta')
                for text in [out['answer'],stream_text]:
                    assert '非全天' in text and '非实测' in text and '排除' in text
                    for e in compare['excluded']:
                        assert f"{e['day_label']} {e['hour']:02d}:{e['minute']:02d}" in text and e['reason'] in text
            row=dict(case=i+1,first_event_ms=round(latency*1000,1),stream_total_ms=round(elapsed*1000,1),json_total_ms=json_ms,
                event_types=types,done=done,json_llm_mode=out['llm_mode'],json_answer_source=out['answer_source'],json_llm=out.get('llm'),tool=out.get('selected_tool'))
            receipt['rows'].append(row);print(json.dumps(row),flush=True)
        receipt['status']='passed';receipt['real_llm_answers']=sum(r['json_answer_source']=='llm_tools' for r in receipt['rows'])
    finally:
        owned.terminate()
        try:owned.wait(timeout=15)
        except subprocess.TimeoutExpired:owned.kill();owned.wait(timeout=5)
        log.close()
        receipt['managed_service_stopped']=True
        Path(args.output).write_text(json.dumps(receipt,indent=2),encoding='utf-8')


if __name__=='__main__':main()
