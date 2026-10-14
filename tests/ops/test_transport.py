"""Real HTTP smoke on a temporary loopback port, always terminated on exit."""
import json
import os
import socket
import subprocess
import sys
import time
import pytest
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from fastapi import FastAPI
from src.api.ops_router import router
from src.ops.config import ROOT, HOUR_MS


def application():
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.mark.parametrize('mode', ['generated', 'live'])
def test_isolated_http_port_and_shutdown(mode):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update(OPS_SOURCE=mode, OPS_TIMEZONE='Asia/Shanghai')
    env.pop('OPS_LIVE_FACTORY', None)
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn',
        'tests.ops.test_transport:application', '--factory', '--host', '127.0.0.1',
        '--port', str(port), '--log-level', 'error'], cwd=ROOT, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def get(path, params=None):
        with urlopen('http://127.0.0.1:'+str(port)+path+'?'+urlencode(params or {}), timeout=5) as response:
            return response.read(), response.headers
    try:
        deadline = time.monotonic()+30
        while True:
            assert process.poll() is None, 'temporary server exited'
            try:
                raw, headers = get('/ops/time')
                break
            except URLError:
                assert time.monotonic() < deadline, 'temporary server startup timed out'
                time.sleep(.1)
        assert headers['Cache-Control'] == 'no-store'
        assert isinstance(json.loads(raw)['epoch_ms'], int)
        if mode == 'live':
            for route, params in [('day',{'date':'2026-10-12'}),('floors',{'date':'2026-10-12'}),('snapshot',{'at_ms':0}),
                                  ('window',{'start_ms':0,'end_ms':1}),('history',{'start_ms':0,'end_ms':1})]:
                with pytest.raises(HTTPError) as error:
                    get('/ops/'+route,params)
                assert error.value.code == 503
        else:
            calendar = json.loads((ROOT/'exports/replay/ops-calendar.json').read_bytes())
            row = next(r for r in calendar['days'] if r['date']=='2026-10-12')
            base = row['day_start_ms']
            raw, _ = get('/ops/day', {'date':row['date']})
            static = (ROOT/'exports/replay'/(row['scenario']+'.ops.json')).read_bytes()
            assert raw == static.replace(b'"day_start_ms":0', b'"day_start_ms":'+str(base).encode(), 1)
            meta = json.loads(raw)['meta']
            floor_raw, _ = get('/ops/floors',{'date':row['date']})
            assert floor_raw == (ROOT/'exports/replay'/meta['floors_file']).read_bytes()
            assert json.loads(get('/ops/snapshot',{'at_ms':base+8*HOUR_MS})[0])['kind']=='snapshot'
            for endpoint in ('window','history'):
                out = json.loads(get('/ops/'+endpoint,{'start_ms':base-HOUR_MS,'end_ms':base+HOUR_MS})[0])
                assert len(out['days']) == 2
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    with socket.socket() as sock:
        assert sock.connect_ex(('127.0.0.1',port)) != 0, 'temporary port left listening'
