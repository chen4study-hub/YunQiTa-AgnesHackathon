"""Common-hour cost/peak comparison under identical new forecast inputs."""
import json,subprocess,copy
from pathlib import Path
from datetime import datetime
from src.data.replay_payload import load_replay
from src.agent.rolling_context import from_replay
from src.agent.temperature_planner import control_metrics
from src.ops.generated import make_row
from src.ops.rules import events,temperature_candidates


def run():
    receipt=json.loads(Path('experiments/round78_export.json').read_text(encoding='utf-8'));result={}
    for name in ('normal','peak','abstain'):
        data=load_replay(name)
        old=json.loads(subprocess.check_output(['git','show',f'a5c8ae0:exports/replay/{name}.json']))
        detail=json.loads(subprocess.check_output(['git','show',f'a5c8ae0:exports/replay/{name}.agent-detail.json']))
        before=[];after=[];preds=[];hours=[];indices=[];ops=[]
        for i,row in enumerate(data['hours']):
            ops.append(make_row(data['meta']['date'],i,row,data['meta']['floor_uses']))
            if row['abstain'] or old['hours'][i]['abstain']:continue
            agent=detail['hours'][str(i)]['agent'];candidate=next(c for c in agent['candidates'] if c['candidate_id']==agent['selected'])
            before.append(next(p for p in candidate['plan'] if p['timestamp']==row['t']))
            selected=next(c for c in row['agent']['candidates'] if c['candidate_id']==row['agent']['selected'])
            after.append(next(p for p in selected['plan'] if p['timestamp']==row['t']))
            f,c,k=from_replay(data,row,.5);preds.append(f['predictions'][0]);hours.append(c['hours'][0]);indices.append(i)
        b=control_metrics(before,preds,hours);a=control_metrics(after,preds,hours)
        alerts,orders=events(data['meta']['date'],ops)
        over=[dict(hour=i,assets=sorted(temperature_candidates(r))) for i,r in enumerate(ops) if temperature_candidates(r)]
        assert not over and not any(e['rule_id']=='temp-high' for e in alerts)
        result[name]=dict(common_accepted_hours=indices,before=b,after=a,
            delta={k:a[k]-b[k] for k in a},percent_change={k:(a[k]/b[k]-1)*100 if b[k] else None for k in a},
            occupied_hourly_max_zone_c=[h['max_zone_c'] for h in receipt['scenarios'][name]['hours'][7:21]],
            zone_histogram={str(t):sum(h['max_zone_c']==t for h in receipt['scenarios'][name]['hours']) for t in sorted({h['max_zone_c'] for h in receipt['scenarios'][name]['hours']})},
            temperature_alert_episodes=len([e for e in alerts if e['rule_id']=='temp-high']),temperature_candidates=over)
    out=dict(status='passed',source_revision='a5c8ae0',comparison='identical daily10 point/upper forecasts and current-hour PV/tariff, same intersection of old/new accepted hours; totals not actual meter savings',
             scope='24 current-hour commands, no repeated rolling-window sums',scenarios=result,ops_read_only=True)
    Path('experiments/round78_comfort.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(out,ensure_ascii=False))


if __name__=='__main__':run()
