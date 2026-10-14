"""Reproduce/fix cancellation in an isolated 8002 service without touching resident DB."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler


def main():
    parser=__import__('argparse').ArgumentParser()
    parser.add_argument('--expect',choices=['manual','executed'],required=True)
    args=parser.parse_args()
    base='http://127.0.0.2:8002'
    opener=build_opener(ProxyHandler({}))
    def request(path,data=None):
        body=json.dumps(data).encode() if data is not None else None
        with opener.open(Request(base+path,body,{'Content-Type':'application/json'}),timeout=30) as response:
            return json.load(response)
    # Full command is retained only in this owned test process; no resident reloads.
    with tempfile.TemporaryDirectory(prefix='yunqi-cancel-') as directory:
        env={**os.environ,'YUNQI_DB_PATH':str(Path(directory)/'test.db')}
        process=subprocess.Popen([sys.executable,'-m','uvicorn','tests.db.cancel_probe_entry:create_app','--factory',
                                  '--host','127.0.0.2','--port','8002'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            for _ in range(150):
                if process.poll() is not None:raise RuntimeError('isolated probe failed to start')
                try:request('/takeover/active?date=2026-10-13&hour=3');break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('probe start timeout')
            data=json.loads(Path('exports/replay/normal.json').read_bytes())
            row=data['hours'][3]
            stamp=__import__('datetime').datetime.fromisoformat(row['t'])
            schedule=dict(building_id=data['meta']['building_id'],scenario='normal',display_date='2026-10-13',
                          start=row['t'],end=(stamp+__import__('datetime').timedelta(hours=1)).isoformat())
            baseline=request('/schedule',schedule)
            item=request('/takeover',dict(date='2026-10-13',hour=3,duration_hours=1,operator_id='检查员甲',
                         hvac_setpoint_c=26.2,storage_mode='idle',storage_power_kw=0,reason='检查设备'))['takeover']
            during=request('/schedule',schedule)
            assert during['status']=='manual'
            request('/takeover/'+item['id']+'/cancel',dict(operator_id='检查员乙',reason='检查结束'))
            active=request('/takeover/active?date=2026-10-13&hour=3')['takeover']
            after=request('/schedule',schedule)
            assert after['status']==args.expect,(args.expect,after['status'])
            if args.expect=='executed':
                assert active['status']=='cancelled'
                assert after['plan']==baseline['plan']
                assert after['needs_human'] is False
                assert not [w for w in after['work_orders'] if w['timestamp']==row['t']]
                assert after['plan'][0]['hvac_setpoint_c']==row['agent']['hvac_setpoint_c']
                selected=next(c for c in row['agent']['candidate_summaries'] if c['candidate_id']==row['agent']['selected'])
                assert round(after['plan'][0]['battery_kw'],1)==round(selected['battery_kw'],1)
            print(json.dumps(dict(probe=base,temporary_db=True,export_status=row['agent']['status'],
                       confidence=row['confidence'],before=baseline['status'],during=during['status'],
                       active_after=active['status'],decision_after=after['status'],
                       current_work_orders=len([w for w in after['work_orders'] if w['timestamp']==row['t']]))))
        finally:
            process.terminate();process.wait(timeout=10)


if __name__=='__main__':main()
