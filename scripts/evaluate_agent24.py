"""Frozen 13-day re-evaluation: current + origin-issued h1..23; first command only."""
import argparse,json,threading
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor
from scripts.evaluate_agent13 import input_data,dates,MeteredProvider,current_economics
from scripts.export_future24 import load_sources
from scripts.export_replay import pv_sim
from scripts.download_bdg2_thermal import sha
from src.agent.rolling_context import rolling_inputs
from src.agent.orchestrator import run_agent,rounded_tools,candidate_evidence,ungrounded_numbers
from src.agent.tools import check_constraints
from src.agent.confidence import gate_confidence
from src.agent.display_text import display_evidence
from src.agent.provider import read_key,redact,get_llm_status

PLAN=Path('experiments/agent_eval_v4_plan.json');HOURS=Path('experiments/agent_eval_v4_hours.jsonl');BINDING=Path('experiments/agent_eval_v4_binding.json')
LOCK=threading.Lock()
CODE=['scripts/evaluate_agent24.py','src/agent/orchestrator.py','src/agent/storage_planner.py','src/agent/rolling_context.py','src/agent/tools.py','src/agent/selection.py','src/agent/provider.py','src/agent/numeric_prompt.py','src/agent/display_text.py','configs/agent_tools.json']


def prepare(day,hour,soc,data,future_sources):
    bundles,cache,weather=data;origin=(datetime.fromisoformat(day)+timedelta(hours=hour)).replace(tzinfo=ZoneInfo('America/Chicago'))
    wall=origin.strftime('%Y-%m-%d %H:%M:%S');r=cache.loc[wall];w=weather.loc[wall];b=bundles[day[:7]]
    confidence,_=gate_confidence(b['confidence_lookup'],r.risk_score,b['risk_threshold'],bool(r.abstain))
    current=dict(timestamp=origin.isoformat(),point=float(r.point),lower=float(r.lower),upper=float(r.upper),confidence=confidence,
        abstain=bool(r.abstain),abstain_reason=str(r.abstain_reason) if bool(r.abstain) else None,risk_score=float(r.risk_score),risk_threshold=b['risk_threshold'])
    index,caches,_,_=future_sources;pred=caches[day[:7]].loc[wall].sort_index()
    if list(pred.index)!=list(range(1,25)):raise ValueError('Complete forecast_24h required')
    future=[]
    for step,p in pred.iterrows():
        future.append(dict(timestamp=(origin+timedelta(hours=int(step))).isoformat(),point=round(float(p.point),1),lower=round(float(p.lower),1),upper=round(float(p.upper),1),
            confidence=float(p.confidence),abstain=bool(p.abstain),abstain_reason='forecast_gate_refused' if p.abstain else None,risk_score=float(p.risk_score),risk_threshold=float(p.risk_threshold)))
    return rolling_inputs('Hog_office_Byron',current,future,float(w.air_temperature),soc,pv_sim(hour,float(w.cloud_coverage)))


def one_hour(day,hour,soc,data,future,group):
    f,c,k=prepare(day,hour,soc,data,future);provider=MeteredProvider()
    result=run_agent(f,c,k,provider=provider,dispatch_current_only=True,dispatch_path=f'logs/agent_eval_v4_dispatch_{day}.jsonl')
    command=result['plan'][0];after=soc-command['battery_kw']/k['battery_capacity_kwh'];refused=f['predictions'][0]['abstain']
    handoff=command['action']=='human_review' and command['battery_kw']==0 and result['receipt']['count']==0 and any(w['timestamp']==command['timestamp'] for w in result['work_orders'])
    steps=[dict(timestamp=r['timestamp'],correct=p['action']=='human_review' and p['battery_kw']==0 and any(w['timestamp']==r['timestamp'] for w in result['work_orders'])) for p,r in zip(result['plan'],f['predictions']) if r['abstain']]
    return dict(date=day,hour=hour,group=group,forecast=f,context=c,constraints=k,result=result,soc_before=soc,soc_after=after,
        economics=current_economics(command,f,c,k),constraint_codes=check_constraints(result['plan'],k),current_constraint_codes=check_constraints([command],k),
        candidate_constraint_codes={a['candidate_id']:check_constraints(a['plan'],k) for a in result['candidates']},current_refused=refused,current_handoff_correct=handoff if refused else None,
        refused_steps=steps,explanation_unsourced_numeric_token_count=len(ungrounded_numbers(result['reason'],display_evidence(dict(forecast=rounded_tools(f),candidates=candidate_evidence(result['candidates'])),f['predictions'][0]['timestamp']))),provider_attempts=provider.attempts)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--hours-per-day',type=int,default=24);parser.add_argument('--workers',type=int,default=4);args=parser.parse_args()
    if get_llm_status()['mode']!='real':raise ValueError('Real configuration required')
    plan=json.loads(PLAN.read_text());selected=dates(plan);data=input_data();future=load_sources()
    binding=dict(plan_sha256=sha(PLAN),code_sha256={p:sha(p) for p in CODE},monthly_index_sha256=sha('experiments/demo_monthly_index.json'),multi_index_sha256=sha('experiments/multi_horizon_v3_index.json'),weather_sha256=sha('data/byron2017.csv'),requested_llm_mode='real')
    if BINDING.exists():
        if json.loads(BINDING.read_text())!=binding:raise ValueError('Frozen code/input changed; do not reuse')
    else:BINDING.write_text(json.dumps(binding,indent=2),encoding='utf-8')
    saved=[json.loads(l) for l in HOURS.read_text(encoding='utf-8').splitlines()] if HOURS.exists() else []
    by_day={i['date']:sorted([r for r in saved if r['date']==i['date']],key=lambda r:r['hour']) for i in selected}
    for records in by_day.values():
        if [r['hour'] for r in records]!=list(range(len(records))):raise ValueError('Checkpoint duplicate/gap')
    def run_day(item):
        day=item['date'];old=by_day[day];soc=old[-1]['soc_after'] if old else .5
        for hour in range(len(old),min(24,len(old)+args.hours_per_day)):
            record=one_hour(day,hour,soc,data,future,item['group']);soc=record['soc_after'];key,_=read_key()
            with LOCK:
                with HOURS.open('a',encoding='utf-8') as file:file.write(json.dumps(redact(record,key),ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n')
                print(json.dumps(dict(date=day,hour=hour,source=record['result']['source'],llm=record['result']['llm'])),flush=True)
    with ThreadPoolExecutor(max_workers=min(4,args.workers)) as pool:list(pool.map(run_day,selected))
    print(json.dumps(dict(status='completed' if sum(1 for _ in HOURS.open(encoding='utf-8'))==312 else 'paused')),flush=True)


if __name__=='__main__':main()
