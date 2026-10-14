"""Local detached supervisor: no Task Scheduler, no env/config writes, bounded restart."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from datetime import datetime,timezone

ROOT=Path(__file__).resolve().parents[1]
LOGS=ROOT/'logs';STATE=LOGS/'backend_supervisor.json';STOP=LOGS/'backend.stop';LOCK=LOGS/'backend_supervisor.lock'


def report(event,**metadata):
    with (LOGS/'backend_supervisor.log').open('a',encoding='utf-8') as f:
        f.write(json.dumps(dict(utc=datetime.now(timezone.utc).isoformat(),event=event,**metadata))+'\n')


def occupied(port):
    with socket.socket() as s:return s.connect_ex(('127.0.0.1',port))==0


def save_state(child,restarts,status):
    value=dict(supervisor_pid=os.getpid(),child_pid=child.pid if child else None,restarts=restarts,status=status,host='127.0.0.1',port=8000)
    temp=STATE.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2),encoding='utf-8');temp.replace(STATE)


def stop_child(child):
    if child and child.poll() is None:
        child.terminate()
        try:child.wait(timeout=10)
        except subprocess.TimeoutExpired:child.kill();child.wait(timeout=10)


def supervise():
    LOGS.mkdir(exist_ok=True)
    # OS releases exclusive lock on supervisor death; never take over live service.
    lock=LOCK.open('a+b');lock.seek(0)
    try:
        if os.name=='nt':
            import msvcrt
            if LOCK.stat().st_size==0:lock.write(b'0');lock.flush();lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        lock.close();print('Supervisor already running');return 2
    if occupied(8000):lock.close();print('Port8000 occupied; no existing process changed');return 2
    STOP.unlink(missing_ok=True);child=None;restarts=0
    command=[sys.executable,'-m','uvicorn','src.api.app:app','--host','127.0.0.1','--port','8000','--access-log','--log-config',str(ROOT/'configs/backend_logging.json')]
    try:
        while not STOP.exists():
            if occupied(8000):
                report('port_occupied_no_takeover');save_state(None,restarts,'blocked');return 2
            # Runtime reads existing.env internally. Never print values/headers/request bodies.
            with (LOGS/'backend_uvicorn.log').open('a',encoding='utf-8') as output:
                child=subprocess.Popen(command,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT)
                save_state(child,restarts,'running');report('child_started',pid=child.pid,restarts=restarts)
                while child.poll() is None and not STOP.exists():time.sleep(.5)
                if STOP.exists():break
                code=child.wait();report('child_exited',exit_code=code);restarts+=1
            save_state(None,restarts,'restarting')
            for _ in range(min(60,10*restarts)):
                if STOP.exists():break
                time.sleep(.5)
        return 0
    finally:
        stop_child(child);save_state(None,restarts,'stopped');report('supervisor_stopped');STOP.unlink(missing_ok=True);lock.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','run','stop','status']);args=parser.parse_args();LOGS.mkdir(exist_ok=True)
    if args.action=='start':
        # Explicit user-requested persistent process, independent of short-lived shell job.
        flags=(subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_BREAKAWAY_FROM_JOB) if os.name=='nt' else 0
        try:
            with (LOGS/'backend_launcher.log').open('a',encoding='utf-8') as out:
                child=subprocess.Popen([sys.executable,'-m','scripts.serve_backend','run'],cwd=ROOT,stdin=subprocess.DEVNULL,
                    stdout=out,stderr=subprocess.STDOUT,creationflags=flags,close_fds=True)
        except PermissionError:
            print('Persistent process denied by current Windows job; run supervisor in a normal terminal. No alternate launch attempted.')
            raise SystemExit(2)
        print('Supervisor launch requested PID='+str(child.pid));return
    if args.action=='run':raise SystemExit(supervise())
    if args.action=='stop':STOP.write_text('stop',encoding='ascii');print('Stop requested; supervisor terminates its child and exits');return
    print(STATE.read_text(encoding='utf-8') if STATE.exists() else 'No supervisor state')


if __name__=='__main__':main()
