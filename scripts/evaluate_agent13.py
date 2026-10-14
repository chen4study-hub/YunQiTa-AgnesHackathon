"""Calendar-frozen13day Agent evaluation; independent days parallel, each day serial."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta
import json
import threading
from pathlib import Path
from zoneinfo import ZoneInfo
import joblib
import pandas as pd
from src.agent.orchestrator import run_agent,candidate_evidence,rounded_tools,ungrounded_numbers
from src.agent.provider import OpenAICompatibleProvider,get_llm_status,read_key,redact
from src.agent.tools import tool_config,check_constraints,simulate_schedule
from src.agent.confidence import gate_confidence
from scripts.export_replay import pv_sim
from scripts.download_bdg2_thermal import sha

PLAN=Path('experiments/agent_eval_v1_plan.json');HOURS=Path('experiments/agent_eval_v1_hours.jsonl');BINDING=Path('experiments/agent_eval_v1_binding.json')
WRITE_LOCK=threading.Lock()


class MeteredProvider:
    def __init__(self):self.provider=OpenAICompatibleProvider();self.attempts=[]
    def choose_candidate(self,forecast,candidates,instruction):
        r=self.provider.choose_candidate(forecast,candidates,instruction)
        choice=r.get('choice',{});missing=ungrounded_numbers(choice.get('reason',''),{'forecast':forecast,'candidates':candidates})
        self.attempts.append(dict(mode=r['llm'].get('mode'),reason=r['llm'].get('reason'),error_type=r['llm'].get('error_type'),status_code=r['llm'].get('status_code'),
            unsourced_numeric_token_count=len(missing)))
        return r


def dates(plan):
    out=[dict(date=d,group=k) for k,d in plan['day_selection']['typical'].items()]
    out += [dict(date=d,group='additional') for d in plan['day_selection']['additional_dates']]
    return out


def input_data():
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text());bundles={};cache=[]
    for item in index['rows']:
        for k in ['artifact','predictions']:
            if sha(item[k])!=item[k+'_sha256']:raise ValueError('Model/input integrity failed')
        bundles[item['month']]=joblib.load(item['artifact']);d=pd.read_csv(item['predictions'])
        d['wall']=pd.to_datetime(d.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');cache.append(d)
    predictions=pd.concat(cache).set_index('wall')
    w=pd.read_csv('data/byron2017.csv');w['wall']=pd.to_datetime(w.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S')
    return bundles,predictions,w.set_index('wall')


def prepare(day,hour,soc,data):
    bundles,cache,weather=data;origin=datetime.fromisoformat(day)+timedelta(hours=hour);horizon=[];context=[];cfg=tool_config()
    for step in [0,1]:
        wall=(origin+timedelta(hours=step)).strftime('%Y-%m-%d %H:%M:%S');t=(origin+timedelta(hours=step)).replace(tzinfo=ZoneInfo('America/Chicago'))
        r=cache.loc[wall];w=weather.loc[wall];b=bundles[wall[:7]]
        confidence,threshold=gate_confidence(b['confidence_lookup'],r.risk_score,b['risk_threshold'],bool(r.abstain))
        horizon.append(dict(timestamp=t.isoformat(),point=float(r.point),lower=float(r.lower),upper=float(r.upper),confidence=confidence,
            abstain=bool(r.abstain),abstain_reason=str(r.abstain_reason) if bool(r.abstain) else None,risk_score=float(r.risk_score),risk_threshold=b['risk_threshold']))
        tariff=cfg['tariff'];period='valley' if t.hour in tariff['valley_hours'] else 'peak' if t.hour in tariff['peak_hours'] else 'flat'
        context.append(dict(timestamp=t.isoformat(),outdoor_temp_c=float(w.air_temperature),pv_kw=pv_sim(t.hour,float(w.cloud_coverage)),
            price_per_kwh=tariff[period],tariff_period=period,storage_soc=soc))
    return {'building_id':'Hog_office_Byron','predictions':horizon},{'hours':context},{**cfg['equipment'],'initial_soc':soc,'peak_target_kw':bundles[day[:7]]['peak_load_threshold']}


def current_economics(command,forecast,context,limits):
    if forecast['predictions'][0]['abstain']:return {k:None for k in ['cost','baseline_cost','hold25_cost','upper_peak','baseline_upper_peak','hold25_upper_peak','comfort_degree_hours']}
    r=forecast['predictions'][0];h=context['hours'][0];sim=simulate_schedule([command],{'predictions':[r]},limits,{'hours':[h]})
    m=tool_config()['linear_model'];factor=max(0.,1-m['load_fraction_per_degree']*(command['hvac_setpoint_c']-m['baseline_setpoint_c'])+m['precool_extra_fraction']*(command['action']=='precool'))
    hold=max(0.,1-m['load_fraction_per_degree']*1.5)
    return dict(cost=sim['estimated_cost'],baseline_cost=max(0.,r['point']-h['pv_kw'])*h['price_per_kwh'],
        hold25_cost=max(0.,r['point']*hold-h['pv_kw'])*h['price_per_kwh'],
        upper_peak=max(0.,r['upper']*factor-h['pv_kw']-command['battery_kw']),baseline_upper_peak=max(0.,r['upper']-h['pv_kw']),
        hold25_upper_peak=max(0.,r['upper']*hold-h['pv_kw']),comfort_degree_hours=sim['comfort_degree_hours'])

def one_hour(day,hour,soc,data,group):
    forecast,context,limits=prepare(day,hour,soc,data);provider=MeteredProvider()
    result=run_agent(forecast,context,constraints=limits,provider=provider,
        dispatch_current_only=True,dispatch_path=f'logs/agent_eval_v1_dispatch_{day}.jsonl')
    command=result['plan'][0];soc_after=soc-command['battery_kw']/limits['battery_capacity_kwh']
    failures=check_constraints(result['plan'],limits);current_failures=check_constraints([command],limits)
    candidate_failures={c['candidate_id']:check_constraints(c['plan'],limits) for c in result['candidates']}
    refused=forecast['predictions'][0]['abstain'];handoff=command['action']=='human_review' and command['battery_kw']==0 and result['receipt']['count']==0 and any(w['timestamp']==command['timestamp'] for w in result['work_orders'])
    each_refused=[dict(timestamp=r['timestamp'],correct=p['action']=='human_review' and p['battery_kw']==0 and any(w['timestamp']==r['timestamp'] for w in result['work_orders'])) for p,r in zip(result['plan'],forecast['predictions']) if r['abstain']]
    evidence=dict(forecast=rounded_tools(forecast),candidates=candidate_evidence(result['candidates']))
    numeric_count=len(ungrounded_numbers(result['reason'],evidence))
    record=dict(date=day,hour=hour,group=group,forecast=forecast,context=context,constraints=limits,result=result,
        soc_before=soc,soc_after=soc_after,economics=current_economics(command,forecast,context,limits),
        constraint_codes=failures,current_constraint_codes=current_failures,candidate_constraint_codes=candidate_failures,
        current_refused=refused,current_handoff_correct=handoff if refused else None,refused_steps=each_refused,
        explanation_unsourced_numeric_token_count=numeric_count,provider_attempts=provider.attempts)
    return record


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--hours-per-day',type=int,default=4);parser.add_argument('--workers',type=int,default=4);args=parser.parse_args()
    if get_llm_status()['mode']!='real':raise RuntimeError('Frozen evaluation requires real configuration')
    plan=json.loads(PLAN.read_text());selected=dates(plan);data=input_data()
    binding=dict(plan_sha256=sha(PLAN),code_sha256={p:sha(p) for p in ['scripts/evaluate_agent13.py','src/agent/orchestrator.py','src/agent/tools.py','src/agent/selection.py','src/agent/provider.py','configs/agent_tools.json']},
        monthly_index_sha256=sha('experiments/demo_monthly_index.json'),weather_sha256=sha('data/byron2017.csv'),requested_llm_mode='real')
    if BINDING.exists():
        if json.loads(BINDING.read_text())!=binding:raise ValueError('Frozen eval code/data changed; refuse reuse')
    else:BINDING.write_text(json.dumps(binding,indent=2),encoding='utf-8')
    saved=[json.loads(line) for line in HOURS.read_text(encoding='utf-8').splitlines()] if HOURS.exists() else []
    by_day={item['date']:sorted([r for r in saved if r['date']==item['date']],key=lambda r:r['hour']) for item in selected}
    for day,records in by_day.items():
        if [r['hour'] for r in records]!=list(range(len(records))):raise ValueError('Checkpoint has gap or duplicate')
    def run_day(item):
        day=item['date'];old=by_day[day];soc=old[-1]['soc_after'] if old else .5
        for hour in range(len(old),min(24,len(old)+args.hours_per_day)):
            record=one_hour(day,hour,soc,data,item['group']);soc=record['soc_after']
            key,_=read_key();safe=redact(record,key)
            with WRITE_LOCK:
                with HOURS.open('a',encoding='utf-8') as f:f.write(json.dumps(safe,ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n')
                print(json.dumps(dict(date=day,hour=hour,source=record['result']['source'],llm=record['result']['llm'])),flush=True)
    with ThreadPoolExecutor(max_workers=min(4,args.workers)) as pool:list(pool.map(run_day,selected))
    n=sum(1 for _ in HOURS.open(encoding='utf-8'));print(json.dumps(dict(status='completed' if n==312 else 'paused',hours=n)),flush=True)


if __name__=='__main__':main()
