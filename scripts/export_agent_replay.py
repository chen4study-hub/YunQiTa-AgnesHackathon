"""24h rolling Agent on current + origin-issued forecast; execute only first hourly command."""
import json
import hashlib
from collections import Counter
from pathlib import Path
from jsonschema import Draft202012Validator
from src.agent.orchestrator import run_agent,candidate_evidence,check_grounding
import argparse
from src.agent.provider import get_llm_status,read_key,redact
from scripts.export_future24 import attach,load_sources
from src.agent.rolling_context import from_replay
from src.agent.manual_reference import align_export_segments
from src.agent.display_text import public_text,display_evidence


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--max-hours',type=int,default=12);args=parser.parse_args()
    if get_llm_status()['mode']!='real':raise RuntimeError('Objective refresh requires configured real mode')
    root=Path('exports/replay');schema=json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'))
    validator=Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER)
    future_sources=load_sources()
    counts=Counter();fallbacks=Counter();by_scenario={};prepared=[];key,_=read_key()
    checkpoint_path=Path('logs/agent_replay_prose_retry_checkpoint.json')
    fingerprint=hashlib.sha256(b''.join(Path(p).read_bytes() for p in ['src/agent/orchestrator.py','src/agent/selection.py','src/agent/storage_planner.py','src/agent/rolling_context.py','src/agent/provider.py','src/agent/numeric_prompt.py','src/agent/display_text.py','src/agent/prose_repair.py','configs/agent_tools.json','scripts/export_agent_replay.py'])).hexdigest()
    fingerprint=hashlib.sha256((fingerprint+Path('experiments/multi_horizon_v3_index.json').read_text()+
        json.dumps([{k:r[k] for k in ['t','point_kw','lower_kw','upper_kw','confidence','abstain','risk_score','risk_threshold','outdoor_temp_c','pv']} for name in ['normal','peak','abstain'] for r in json.loads((root/f'{name}.json').read_text(encoding='utf-8'))['hours']],sort_keys=True)).encode()).hexdigest()
    saved_state=json.loads(checkpoint_path.read_text(encoding='utf-8')) if checkpoint_path.exists() else {'fingerprint':fingerprint,'hours':{}}
    if saved_state['fingerprint']!=fingerprint:raise ValueError('Checkpoint code changed; refuse reuse')
    checkpoint=saved_state['hours'];processed=0
    for scenario in ('normal','peak','abstain'):
        from src.data.replay_payload import load_replay
        path=root/f'{scenario}.json';data=attach(load_replay(scenario,root),future_sources);soc=.5;counts_day=Counter()
        for i,current in enumerate(data['hours']):
            saved=checkpoint.get(scenario,{}).get(str(i))
            if saved:
                data['hours'][i]=saved['hour'];soc=saved['soc'];source=saved['source']
                counts_day[source]+=1;counts[source]+=1
                if source=='rule':fallbacks[saved['reason']]+=1
                continue
            if processed>=args.max_hours:
                print(json.dumps({'status':'paused','new_hours':processed}),flush=True);return
            forecast,context,limits=from_replay(data,current,soc);horizon=forecast['predictions']
            result=run_agent(forecast,context,constraints=limits,dispatch_current_only=True)
            command=result['plan'][0];refused=horizon[0]['abstain']
            source='rule' if result['source']=='rule' or (result['source']=='mock' and get_llm_status()['mode']=='real') else 'llm' if result['source']=='llm' else 'mock'
            power=command['battery_kw'];soc-=power/2000
            # Use exact action values consistently, SOC within hard bounds before display rounding.
            current['storage']={'power_kw':power,'soc':round(soc,6)}
            current['grid_kw']=round(max(0.,current['actual_kw']-power-current['pv']['power_kw']),1)
            orders=[w for w in result['work_orders'] if w['timestamp']==current['t']]
            explanation=('低置信度，已转交人工。' if refused else result['reason'])
            actions=[] if refused else [f"BA设定温度 {command['hvac_setpoint_c']:.1f} °C",f"EMS储能功率 {power:.1f} kW"]
            if any(word in explanation+' '.join(actions) for word in ('影子','模拟','估算')):
                explanation=f"按区间上界 {horizon[0]['upper']:.1f} kW 准备，指令已自动下发。"
            current['agent']=dict(status='handoff' if refused else 'executed',source=source,
                hvac_setpoint_c=command['hvac_setpoint_c'],actions=actions,explanation=explanation,
                work_orders=orders,manual_reference=result['manual_reference'],receipt=result['receipt'],selected=result['selected'],selection_reason=result['selection_reason'],
                candidates=candidate_evidence(result['candidates']),llm_mode=result['llm']['mode'],llm=result['llm'],
                explanation_source=result['explanation_source'] if not refused and explanation==result['reason'] else 'template')
            evidence=display_evidence({'forecast':horizon,'candidates':current['agent']['candidates']},current['t'])
            current['agent']['explanation']=explanation=public_text(explanation,current['t'],evidence)
            if not check_grounding(explanation,evidence):raise ValueError('Export Agent not grounded')
            if current['agent']['selected']!=current['agent']['selection_reason']['selected_candidate_id']:raise ValueError('Selected mismatch')
            counts_day[source]+=1;counts[source]+=1
            if source=='rule':fallbacks[result['llm'].get('reason','unknown')]+=1
            checkpoint.setdefault(scenario,{})[str(i)]={'hour':redact(current,key),'soc':soc,'source':source,
                'reason':result['llm'].get('reason','unknown')}
            checkpoint_path.write_text(json.dumps({'fingerprint':fingerprint,'hours':checkpoint},ensure_ascii=False,allow_nan=False),encoding='utf-8')
            processed+=1
            print(json.dumps({'scenario':scenario,'hour':i,'source':source,'llm':result['llm']}),flush=True)
        data=attach(data,future_sources)
        align_export_segments(data)
        data=redact(data,key);validator.validate(data)
        prepared.append((path,json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False)))
        by_scenario[scenario]=dict(counts_day)
    for path,content in prepared:path.write_text(content,encoding='utf-8')
    receipt=dict(status='completed',schema_version='1.4',explanation_categories_by_scenario={
        p.stem:dict(Counter('rule' if r['agent']['source']=='rule' else r['agent']['explanation_source'] for r in json.loads(content)['hours'])) for p,content in prepared},llm_status=get_llm_status(),hours_by_source=dict(counts),by_scenario=by_scenario,
        export_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p,c in prepared},
        fallback_reasons=dict(fallbacks),fallback_reasons_by_scenario={name:dict(Counter(
            h['reason'] for h in checkpoint.get(name,{}).values() if h['source']=='rule')) for name in ('normal','peak','abstain')},next_hour_lookahead=False,current_hour_dispatch_only=True,device_connected=False,
        exported_scenarios=['normal','peak','abstain'],abstain_preserved=True,selection_policy='upper_grid_peak_tolerance_then_cost_v2',controls_refreshed=True,
        checkpoint_fingerprint=fingerprint,real_mode_requested=True,llm_export_calls_authorized=True,
        source_counts_note='rule includes current refusal bypass; future refusal does not bypass LLM',
        planning_horizon_hours=24,forecast_scope='current execution hour plus origin-issued forecast_24h h1..h23',terminal_soc_at_least_initial=True,current_gate_only=True,distinct_candidate_metric_precision_decimals=1)
    Path('experiments/agent_replay_export.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    from scripts.compact_replay import main as compact
    compact();print(json.dumps(receipt,indent=2))


if __name__=='__main__':main()
