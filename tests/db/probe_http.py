"""Loopback HTTP probe with a temporary database and an owned subprocess only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen


def request(port,path,data=None):
    body=json.dumps(data).encode() if data is not None else None
    req=Request(f'http://127.0.0.1:{port}'+path,body,{'Content-Type':'application/json'})
    with urlopen(req,timeout=5) as response:
        return json.load(response)


def main():
    # Reserve an available high port; never contact/stop the resident backend.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
    if port<=8100:
        raise RuntimeError('probe port must be above 8100')
    with tempfile.TemporaryDirectory(prefix='yunqi-http-') as directory:
        env={**os.environ,'YUNQI_DB_PATH':str(Path(directory)/'probe.db')}
        process=None
        def start():
            return subprocess.Popen([sys.executable,'-m','uvicorn','src.db.standalone:create_app','--factory','--host','127.0.0.1','--port',str(port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def ready():
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('owned probe failed to start')
                try:return request(port,'/takeover/active?date=2026-10-12&hour=10')
                except OSError:time.sleep(.1)
            raise RuntimeError('owned probe startup timed out')
        try:
            process=start();ready()
            rec=request(port,'/takeover/recommendation?date=2026-10-12&hour=10')
            assert rec['available']
            data=dict(date='2026-10-12',hour=10,duration_hours=1,operator_id='HTTP检查员',hvac_setpoint_c=25.3,
                      storage_mode='idle',storage_power_kw=0,reason='核对后调整温控',recommendation_hash=rec['recommendation_hash'])
            item=request(port,'/takeover',data)['takeover']
            receipt=request(port,'/dispatch/receipt?date=2026-10-12&hour=10&operator_id=http-reader')
            assert receipt['source']=='manual' and len(receipt['records'])==2
            process.terminate();process.wait(timeout=10)
            process=start();ready()
            active=request(port,'/takeover/active?date=2026-10-12&hour=10')['takeover']
            assert active['id']==item['id'] and active['hvac_setpoint_c']==25.3
            request(port,'/takeover/'+item['id']+'/cancel',dict(operator_id='HTTP检查员',reason='结束检查'))
            audits=request(port,'/audit?date=2026-10-12')['items']
            assert any(a['action']=='create' for a in audits) and any(a['action']=='cancel' for a in audits)
            print(json.dumps(dict(status='passed',port=port,temporary_database=True,resident_untouched=True,owned_restart_persistence=True)))
        finally:
            if process is not None and process.poll() is None:
                process.terminate();process.wait(timeout=10)


if __name__=='__main__':
    main()
