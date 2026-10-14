import json
from pathlib import Path
from scripts import serve_backend as service


def local(monkeypatch,tmp):
    for name,value in [('ROOT',tmp),('LOGS',tmp/'logs'),('STATE',tmp/'logs/state.json'),('STOP',tmp/'logs/stop'),('LOCK',tmp/'logs/lock')]:monkeypatch.setattr(service,name,value)
    (tmp/'logs').mkdir();monkeypatch.setattr(service,'occupied',lambda port:False)


def test_supervisor_crashed_child_restarts_then_stops_only_own_child(monkeypatch,tmp_path):
    local(monkeypatch,tmp_path);children=[]
    class Child:
        def __init__(self,command,**kw):
            self.pid=100+len(children);self.dead=False
            assert command[1:5]==['-m','uvicorn','src.api.app:app','--host'] and '--access-log' in command and '--no-access-log' not in command
            assert command[command.index('--log-config')+1]==str(tmp_path/'configs/backend_logging.json')
            assert 'env' not in kw and kw['cwd']==tmp_path
            children.append(self)
            if len(children)>1:service.STOP.write_text('stop')
        def poll(self):return 1 if len(children)==1 or self.dead else None
        def wait(self,**kw):return 1
        def terminate(self):self.dead=True
        def kill(self):self.dead=True
    monkeypatch.setattr(service.subprocess,'Popen',Child);monkeypatch.setattr(service.time,'sleep',lambda seconds:None)
    assert service.supervise()==0
    state=json.loads(service.STATE.read_text());assert state['restarts']==1 and state['status']=='stopped'
    assert len(children)==2 and children[-1].dead and not service.STOP.exists()
    text=(service.LOGS/'backend_supervisor.log').read_text();assert 'child_exited' in text and 'supervisor_stopped' in text


def test_supervisor_will_not_replace_occupied_service(monkeypatch,tmp_path):
    local(monkeypatch,tmp_path);monkeypatch.setattr(service,'occupied',lambda port:True)
    monkeypatch.setattr(service.subprocess,'Popen',lambda *a,**k:(_ for _ in ()).throw(AssertionError('must not launch')))
    assert service.supervise()==2
