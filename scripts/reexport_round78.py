"""Deploy daily10 forecasts and Ops-aligned comfort in all three frozen days."""
import os
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):os.environ[key]='1'
import copy,hashlib,json,re
from pathlib import Path
from datetime import datetime
from collections import Counter
import pandas as pd
from src.data.replay_payload import load_replay,split_payload
from src.agent.orchestrator import run_agent
from src.agent.rolling_context import from_replay
from src.agent.manual_reference import align_export_segments
from src.agent.zone_comfort import maximum_zone_temperature,occupied
from src.agent.display_text import render_public_fields
from scripts.reexport_round77 import Offline,migrate_saved_prose
from scripts.compact_replay import encode,validate_pair
from scripts.refresh_live_display import categories
from src.ops.metrics import floor_rows

OUT=Path('experiments/round78_export.json')
ROOT=Path('exports/replay')
DROP='仅比较可自动调度的时段，拒绝时段不计费用。'


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def clean(text):
    text=text.replace(DROP,'')
    text=re.sub(r'仅比较可自动调度的时段[，；]拒绝时段不计费用[。；]?','',text)
    return render_public_fields({'explanation':text})['explanation']


def forecast_values(p):
    return dict(lower_kw=round(float(p.lower),1),upper_kw=round(float(p.upper),1),confidence=float(p.confidence),
                confidence_threshold=float(p.confidence_threshold),risk_score=float(p.risk_score),risk_threshold=float(p.risk_threshold),
                abstain=bool(p.abstain))


def maxzones(data,row):
    t=datetime.fromisoformat(row['t']);fs,_,_=floor_rows(t.date().isoformat(),t.hour,row,data['meta']['floor_uses'])
    return max(z['temp_c'] for f in fs for z in f['zones'])


def run():
    if OUT.exists():raise FileExistsError('round78 already exported')
    receipt=json.loads(Path('experiments/round78_calibration.json').read_text());report={};prepared={}
    for name in ('normal','peak','abstain'):
        old=load_replay(name);data=copy.deepcopy(old);date=data['meta']['date']
        item=next(i for i in receipt['rows'] if i['month']==date[:7])
        for field in ('one','multi'):assert sha(item[field+'_path'])==item[field+'_sha256']
        one=pd.read_csv(item['one_path']);one['wall']=pd.to_datetime(one.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');one=one.set_index('wall')
        multi=pd.read_csv(item['multi_path']);multi['wall']=pd.to_datetime(multi.origin,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');multi=multi.set_index(['wall','horizon'])
        data['meta']['daily_calibration']=dict(version=receipt['version'],building=receipt['building'],days=10,min_rows=120,clock=receipt['calibration_clock'],cold_start_enabled=False)
        soc=.5;changes=[];future_count_before=0;future_count_after=0
        for i,row in enumerate(data['hours']):
            original=old['hours'][i];previous=original['agent'];t=datetime.fromisoformat(row['t']);wall=t.strftime('%Y-%m-%d %H:%M:%S');p=one.loc[wall]
            assert round(float(p.point),1)==row['point_kw'];row.update(forecast_values(p));row['abstain_reason']=p.abstain_reason if isinstance(p.abstain_reason,str) else None
            for f in row['forecast_24h']:
                p=multi.loc[(wall,f['horizon'])];assert round(float(p.point),1)==f['point_kw'];future_count_before+=int(f['abstain']);f.update(forecast_values(p));f['abstain_reason']=p.abstain_reason if isinstance(p.abstain_reason,str) else None;future_count_after+=int(f['abstain'])
                assert pd.Timestamp(p.cal_end)<pd.Timestamp(wall,tz='UTC').floor('D')
            forecast,context,limits=from_replay(data,row,soc)
            result=run_agent(forecast,context,limits,provider=Offline(),dispatch_enabled=False,dispatch_current_only=True)
            command=result['plan'][0];power=command['battery_kw'];soc-=power/limits['battery_capacity_kwh'];row['storage']=dict(power_kw=power,soc=soc)
            row['grid_kw']=round(max(0.,row['actual_kw']-power-row['pv']['power_kw']),1)
            # Fresh rejection is rule provenance, not a fabricated saved LLM decision.
            source=previous['source'];explanation_source=previous['explanation_source']
            if row['abstain'] and not original['abstain']:source='rule';explanation_source='template'
            if row['abstain']:reason=f"当前小时转交人工，空调保持 {command['hvac_setpoint_c']:.1f} °C，储能不充放电。"
            elif explanation_source=='llm':reason=migrate_saved_prose(previous,result,row)
            else:reason=result['reason']
            reason=clean(reason)
            # Begin with current-hour action; keep host-derived numbers and provenance distinct.
            if not row['abstain']:reason=f"空调设定 {command['hvac_setpoint_c']:.1f} °C，"+(f"储能{'放电' if power>0 else '充电'} {abs(power):,.1f} kW。" if round(power,1) else '储能待机。')+reason
            row['agent']={**result,'status':'handoff' if row['abstain'] else 'executed','source':source,'explanation_source':explanation_source,
                'hvac_setpoint_c':command['hvac_setpoint_c'],'actions':[] if row['abstain'] else [f"BA设定温度 {command['hvac_setpoint_c']:.1f} °C",f"EMS储能功率 {power:,.1f} kW"],
                'explanation':reason,'receipt':result['receipt'],'llm_mode':previous.get('llm_mode','rule'),
                'llm':{**previous.get('llm',{}),'offline_control_refresh':True,'saved_explanation':previous['explanation'],
                    'historical_receipt':previous['receipt'],'attribution_scope':'historical paragraph with host bound numeric edits; no new LLM choice; no dispatch'}}
            for field in ('plan','reason','building_id'):row['agent'].pop(field,None)
            for candidate in row['agent']['candidates']:
                candidate['selection_reason']['summary']=clean(candidate['selection_reason']['summary'])
                if candidate['candidate_id']==result['selected']:assert candidate['temperature_optimization']['selection_guard_passed']
                assert candidate['temperature_optimization']['max_zone_temperature_c']<=27.
            row['agent']['selection_reason']['summary']=clean(row['agent']['selection_reason']['summary'])
            for ref in result['manual_reference']:
                j=next(j for j,pred in enumerate(forecast['predictions']) if pred['timestamp']==ref['timestamp'])
                assert not occupied(forecast['predictions'][j]) or maximum_zone_temperature(forecast['predictions'][j],context['hours'][j],ref['hvac_setpoint_c'])<=27.
            before=previous['selection_reason']['metrics'][previous['selected']];after=result['selection_reason']['metrics'][result['selected']]
            z=maxzones(data,row);assert not 7<=i<=20 or z<=27.
            changes.append(dict(hour=i,before_abstain=original['abstain'],after_abstain=row['abstain'],old_temperature=previous['hvac_setpoint_c'],new_temperature=command['hvac_setpoint_c'],
                before_metrics=before,after_metrics=after,before_max_zone_c=maxzones(old,original),max_zone_c=z,
                actual_battery_kw=power,manual_reference_count=len(result['manual_reference'])))
        align_export_segments(data);data=render_public_fields(data)
        data['meta']['confidence_threshold']=data['hours'][0]['confidence_threshold']
        main,detail=split_payload(data);raw=encode(main);detail['main_sha256']=hashlib.sha256(raw).hexdigest();validate_pair(main,detail,data)
        prepared[ROOT/(name+'.json')]=raw;prepared[ROOT/(name+'.agent-detail.json')]=encode(detail)
        report[name]=dict(source_counts_before=categories(old),source_counts_after=categories(main),
            refusal_hours_before=[i for i,h in enumerate(old['hours']) if h['abstain']],refusal_hours_after=[i for i,h in enumerate(data['hours']) if h['abstain']],
            future_refusals_before=future_count_before,future_refusals_after=future_count_after,
            current_gate_before=dict(Counter(h['agent']['status'] for h in old['hours'])),current_gate_after=dict(Counter(h['agent']['status'] for h in data['hours'])),
            before_sha256=sha(ROOT/(name+'.json')),main_bytes=len(raw),detail_bytes=len(encode(detail)),hours=changes)
    for p,raw in prepared.items():p.write_bytes(raw)
    r=dict(status='passed',schema_version='1.5',calibration=receipt['version'],new_llm_calls=0,new_dispatches=0,scenarios=report,
           after_sha256={p.name:sha(p) for p in prepared},ops_files_changed=False,ops_regeneration_required=True,
           source_note='historical edited prose retained only for still accepted hours; newly refused hour is rule; original paragraphs/receipts in detail audit',
           contract_changes=['optional meta.daily_calibration','optional temperature_optimization zone comfort fields','forecast risk/confidence thresholds now daily; points unchanged'],
           explanation_cleanup='repeated accepted-only costing sentence removed offline; costing scope documented on About')
    OUT.write_text(json.dumps(r,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({k:v for k,v in r.items() if k!='scenarios'},ensure_ascii=False))


if __name__=='__main__':run()
