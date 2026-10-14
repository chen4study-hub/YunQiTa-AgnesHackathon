"""Secret-safe local health/chat probe. --managed tests own supervisor restart then cleans up."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from scripts.serve_backend import ROOT,STATE,STOP,LOGS


def request(path,payload=None):
    data=json.dumps(payload,ensure_ascii=False).encode() if payload is not None else None
    req=urllib.request.Request('http://127.0.0.1:8000'+path,data=data,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=110 if payload is not None else 3) as r:return json.load(r)


def health_wait(seconds=30):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:return request('/health')
        except Exception:time.sleep(.5)
    raise RuntimeError('Local backend health unavailable')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--managed',action='store_true');args=parser.parse_args();owned=None;receipt={}
    try:
        if args.managed:
            # Self-contained verification, not advertised as persistent activation.
            try:request('/health')
            except Exception:pass
            else:raise RuntimeError('Existing backend detected; do not stop/take over')
            owned=subprocess.Popen([sys.executable,'-m','scripts.serve_backend','run'],cwd=ROOT)
        h=health_wait();receipt['health_llm_mode']=h['llm']['mode']
        if args.managed:
            state=json.loads(STATE.read_text());assert state['supervisor_pid']==owned.pid
            subprocess.run(['taskkill','/PID',str(state['child_pid']),'/F'],capture_output=True,check=True)
            end=time.monotonic()+30
            while time.monotonic()<end:
                new=json.loads(STATE.read_text())
                if new['restarts']>=1 and new['child_pid'] and new['child_pid']!=state['child_pid']:break
                time.sleep(.5)
            else:raise RuntimeError('Supervisor did not restart child')
            health_wait();receipt['restart_verified']=True
        payload={'scenario':'normal','origin':'2017-10-23T12:00:00-05:00','question':'未来24小时负荷峰值在哪个小时，多少kW？'}
        r=request('/chat',payload);receipt['chat']={k:r.get(k) for k in ['known','grounded','llm_mode','llm_called','answer_source','selected_tool','llm']}
        receipt['real_chat_verified']=bool(r.get('known') and r.get('grounded') and r.get('llm_mode')=='real' and r.get('answer_source')=='llm_tools')
    finally:
        if owned:
            STOP.write_text('stop',encoding='ascii')
            try:owned.wait(timeout=15)
            except subprocess.TimeoutExpired:owned.terminate();owned.wait(timeout=10)
            receipt['managed_test_stopped']=True
        receipt['persistent_activation']=False if owned else None
        LOGS.mkdir(exist_ok=True);(LOGS/'backend_probe.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        print(json.dumps(receipt,ensure_ascii=True),flush=True)


if __name__=='__main__':main()
