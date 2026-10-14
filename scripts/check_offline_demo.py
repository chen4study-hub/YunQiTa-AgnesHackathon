"""Isolated no-.env/no-credentials offline HTTP/SSE demo; only loopback sockets allowed."""
import argparse,json,os,shutil,socket,subprocess,sys,tempfile,time,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def clean_environment():
    env={k:v for k,v in os.environ.items() if not k.startswith(('LLM_','AGNES_','OPENAI_','ANTHROPIC_')) and k not in ('PYTHONPATH','BUILDING_DATA_CSV','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')}
    env['LLM_MODE']='demo';env['PYTHON_DOTENV_DISABLED']='1';env['NO_PROXY']='127.0.0.1,localhost'
    return env


def isolated_server(port):
    # Enforce no external DNS/socket connections before importing project packages.
    violations=[];original_connect=socket.socket.connect;original_connect_ex=socket.socket.connect_ex;original_dns=socket.getaddrinfo
    def allowed(address):
        return isinstance(address,tuple) and address[0] in ('127.0.0.1','::1','localhost')
    def connect(self,address):
        if not allowed(address):violations.append('blocked_external_connect');raise OSError('offline external connection blocked')
        return original_connect(self,address)
    def connect_ex(self,address):
        if not allowed(address):violations.append('blocked_external_connect');raise OSError('offline external connection blocked')
        return original_connect_ex(self,address)
    def dns(host,*args,**kwargs):
        if host not in ('127.0.0.1','::1','localhost',None):violations.append('blocked_external_dns');raise OSError('offline external DNS blocked')
        return original_dns(host,*args,**kwargs)
    socket.socket.connect=connect;socket.socket.connect_ex=connect_ex;socket.getaddrinfo=dns
    from src.api.app import app
    @app.get('/_offline_check_guard')
    def guard():return {'external_attempts':len(violations),'dotenv_absent':not Path('.env').exists(),'llm_env':'demo'}
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=port,log_level='critical',access_log=False)


def check(output):
    receipt={'status':'running','requests':[]}
    with tempfile.TemporaryDirectory(prefix='agnes-offline-') as temp:
        temp=Path(temp)
        # Copy only executable backend + public exports/config; never .env/secrets/keys.
        for name in ['src','configs','exports','migrations']:
            shutil.copytree(ROOT/name,temp/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        (temp/'scripts').mkdir();shutil.copyfile(Path(__file__),temp/'scripts/check_offline_demo.py')
        shutil.copyfile(ROOT/'scripts/replay_floor_allocation.py',temp/'scripts/replay_floor_allocation.py')
        assert not (temp/'.env').exists()
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        env=clean_environment();env.pop('DATABASE_URL',None)
        env['YUNQI_DB_PATH']=str(temp/'data/offline-check.db')
        owned=subprocess.Popen([sys.executable,'-m','scripts.check_offline_demo','--server',str(port)],cwd=temp,
            env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=f'http://127.0.0.1:{port}'
        def request(path,payload=None):
            req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Content-Type':'application/json'})
            with opener.open(req,timeout=20) as response:
                assert response.status==200
                return response.read()
        try:
            for _ in range(60):
                try:health=json.loads(request('/health'));break
                except (OSError,ValueError):
                    if owned.poll() is not None:raise RuntimeError('Offline backend exited')
                    time.sleep(.25)
            else:raise RuntimeError('Offline backend startup timeout')
            assert health['status']=='ok' and health['llm']['mode'] in ('demo','mock')
            mode=health['llm']['mode'];receipt['requests'].append({'path':'/health','status':200,'llm_mode':mode})
            index=json.loads(request('/replay'));assert len(index)==3
            receipt['requests'].append({'path':'/replay','status':200,'runtime_llm_mode':mode,'mode_basis':'health; static export index has no llm_mode'})
            peak=json.loads(request('/replay/peak'));assert len(peak['hours'])==24
            receipt['requests'].append({'path':'/replay/peak','status':200,'runtime_llm_mode':mode,'mode_basis':'health; historical agent.llm_mode preserved, not a runtime call'})
            # Choose accepted current hour, never hide the rule-mode of refused current.
            row=next(r for r in peak['hours'] if not r['abstain'])
            from datetime import datetime,timedelta
            payload={'building_id':peak['meta']['building_id'],'scenario':'peak','start':row['t'],
                'end':(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()}
            out=json.loads(request('/schedule',payload))
            assert out['llm_mode'] in ('demo','mock') and out['receipt']['count']==2 and not out['receipt']['device_connected']
            receipt['requests'].append({'path':'/schedule','status':200,'llm_mode':out['llm_mode'],'commands':out['receipt']['count']})
            question={'scenario':'peak','origin':row['t'],'question':'现在储能SOC多少'}
            out=json.loads(request('/chat',question))
            assert out['known'] and out['grounded'] and not out['llm_called'] and out['llm_mode'] in ('demo','mock')
            receipt['requests'].append({'path':'/chat','status':200,'llm_mode':out['llm_mode'],'grounded':True})
            events=[json.loads(line.removeprefix('data: ')) for line in request('/chat/stream',question).decode().splitlines() if line]
            assert events and not any(e['type']=='error' for e in events)
            done_positions=[i for i,e in enumerate(events) if e['type']=='done']
            assert done_positions==[len(events)-1], 'Expected one terminal done event'
            pending={};started=0;answered=0
            for i,event in enumerate(events):
                kind=event['type']
                if kind in ('tool_start','tool_end'):
                    assert isinstance(event['tool'],str) and event['tool']
                    # IDs distinguish concurrent calls; legacy tools pair by name.
                    key=('id',event['id']) if 'id' in event else ('tool',event['tool'])
                    if kind=='tool_start':
                        pending.setdefault(key,[]).append((i,event['tool']));started+=1
                    else:
                        assert pending.get(key), 'Tool end without matching start'
                        before,tool=pending[key].pop(0)
                        assert before<i and tool==event['tool']
                elif kind=='answer_delta':
                    assert i<done_positions[0]
                    assert isinstance(event['text'],str) and event['text']
                    answered+=1
            assert started and answered and not any(pending.values()), 'Incomplete tool/answer stream'
            done=events[-1]
            for field,expected in (('known',True),('needs_human',False),('grounded',True),('terminated',False)):
                assert type(done[field]) is bool and done[field] is expected
            for field,expected in (('explanation_source','template'),('reason','answered'),('mode','fallback'),('category','none')):
                assert isinstance(done[field],str) and done[field]==expected
            assert done['session_id'] is None  # No session was supplied in this request.
            # Timing diagnostics may grow without changing the answer contract.
            if 'phase_timings' in done:assert isinstance(done['phase_timings'],list)
            if 'classification_timing' in done:assert isinstance(done['classification_timing'],dict)
            receipt['requests'].append({'path':'/chat/stream','status':200,'runtime_llm_mode':mode,
                'mode_basis':'same demo process; SSE done confirms fallback template answer','event_types':[e['type'] for e in events]})
            guard=json.loads(request('/_offline_check_guard'));assert guard['external_attempts']==0 and guard['dotenv_absent']
            receipt.update(status='passed',dotenv_absent=True,credentials_absent=True,external_attempts=0,guard='loopback-only DNS/connect/connect_ex')
        finally:
            owned.terminate()
            try:owned.wait(timeout=15)
            except subprocess.TimeoutExpired:owned.kill();owned.wait(timeout=5)
            receipt['managed_backend_stopped']=True
    destination=ROOT/output;destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(receipt,ensure_ascii=True))
    return receipt


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--server',type=int);parser.add_argument('--output',default='experiments/offline_demo_check.json');args=parser.parse_args()
    if args.server is not None:isolated_server(args.server)
    else:check(args.output)
