"""Offline planner refresh; saved prose attribution retained, no new LLM/dispatch."""
import copy,hashlib,json,re
from pathlib import Path
from collections import Counter
from src.agent.orchestrator import run_agent,check_grounding,rounded_tools
from src.agent.rolling_context import from_replay
from src.agent.manual_reference import align_export_segments
from src.agent.display_text import render_public_fields,numeric_tokens,unit_text,number_text,display_evidence
from src.agent.prose_repair import repair_prose
from src.data.replay_payload import load_replay,split_payload,hydrate_hour
from scripts.compact_replay import encode,validate_pair
from scripts.refresh_live_display import categories

ROOT=Path('exports/replay')


class Offline:
    def choose_candidate(self,*args):return {'choice':{},'llm':{'mode':'rule','reason':'key_unavailable'}}


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def migrate_saved_prose(old,result,row):
    # Retain only historical model sentences still true under the refreshed plan.
    # Replace named metric values with corresponding refreshed values, not arbitrary numbers.
    previous=old.get('selection_reason',{}).get('metrics',{}).get(old['selected'],{})
    current=result['selection_reason']['metrics'][result['selected']]
    text=old['explanation']
    names={'rule_full':'全额调度','rule_conservative':'保守调度','rule_hold':'保持设定'}
    if old['selected']!=result['selected']:text=text.replace(names[old['selected']],names[result['selected']])
    text=text.replace('，两项均优于保持方案','')
    for field in ['upper_grid_peak_kw','energy_cost_cny']:
        before=previous.get(field);after=current.get(field)
        if before is not None and after is not None:
            unit='kW' if field=='upper_grid_peak_kw' else '元'
            text=re.sub(r'(?<![\d.])'+re.escape(f'{before:,.1f}')+r'\s*'+unit,f'{after:,.1f} '+unit,text)
    # Action/clock/SOC claims must not be inherited after replanning; metrics-only
    # historical prose can be used after field-bound update and numeric validation.
    surviving=[]
    evidence=display_evidence(rounded_tools(result['candidates']),row['t'],row)
    for sentence in re.split(r'(?<=[。！？])',text):
        if not sentence.strip():continue
        if re.search(r'\d{2}:\d{2}|空调|设定|充电|放电|预冷|储能|电量|收益|节省',sentence):continue
        if any(w in sentence for w in ['复核','上限','约束','通过','规则']):continue
        if check_grounding(sentence,evidence):surviving.append(sentence)
    # A historical numeric selection paragraph is an edited LLM paragraph, not a
    # new model decision. Keep exact saved attribution and archive the original.
    paragraph=''.join(surviving)
    if old.get('explanation_source')=='llm' and not paragraph:
        # Historical template-rendered mixed prose: retain a qualitative clause,
        # stripped of stale actions/numbers; no new claim about model selection.
        safe=[sentence for sentence in re.split(r'(?<=[。！？])',text) if sentence.strip() and not numeric_tokens(sentence)
              and all(w not in sentence for w in ['储能','空调','充电','放电','保持','上限','设定','预冷'])]
        if not safe:raise ValueError('no reusable historical prose; '+row['t']+' '+text)
        paragraph=''.join(safe)
    return paragraph+result['reason']


def main():
    if Path('experiments/round77_export.json').exists():raise FileExistsError('round77 export already complete')
    prepared={};report={};before_hash={};expected={'normal':{'llm':16,'template':8},'peak':{'llm':15,'template':7,'rule':2},'abstain':{'llm':11,'template':1,'rule':12}}
    for name in ('normal','peak','abstain'):
        old=load_replay(name);data=copy.deepcopy(old);soc=.5;changes=[]
        for suffix in ['.json','.agent-detail.json']:before_hash[name+suffix]=sha(ROOT/(name+suffix))
        for i,row in enumerate(data['hours']):
            previous=copy.deepcopy(row['agent']);forecast,context,limits=from_replay(data,row,soc)
            result=run_agent(forecast,context,limits,provider=Offline(),dispatch_enabled=False,dispatch_current_only=True)
            selected=next(c for c in result['candidates'] if c['candidate_id']==result['selected']);guard=selected['temperature_optimization']
            assert guard['selection_guard_passed']
            command=result['plan'][0];refused=forecast['predictions'][0]['abstain'];power=command['battery_kw'];soc-=power/limits['battery_capacity_kwh']
            row['storage']={'power_kw':power,'soc':soc};row['grid_kw']=round(max(0.,row['actual_kw']-power-row['pv']['power_kw']),1)
            reason='低置信度，已转交人工。' if refused else migrate_saved_prose(previous,result,row) if previous['explanation_source']=='llm' else result['reason']
            row['agent']={**result,'status':'handoff' if refused else 'executed','source':previous['source'],
                'explanation_source':previous['explanation_source'],'hvac_setpoint_c':command['hvac_setpoint_c'],
                'actions':[] if refused else [f"BA设定温度 {command['hvac_setpoint_c']:.1f} °C",f"EMS储能功率 {power:.1f} kW"],
                'explanation':reason,'receipt':previous['receipt'],'llm_mode':previous.get('llm_mode','rule'),
                'llm':{**previous.get('llm',{}),'offline_control_refresh':True,'saved_explanation':previous['explanation'],
                    'attribution_scope':'saved historical prose, host-replanned controls; no new model choice'}}
            row['agent'].pop('plan',None);row['agent'].pop('reason',None);row['agent'].pop('building_id',None)
            # Legacy receipts are historical log provenance, not newly sent controls.
            row['agent']['llm']['receipt_scope']='historical receipt retained; offline refresh sends nothing'
            assert [p['abstain'] for p in forecast['predictions']]==[row['abstain']]+[p['abstain'] for p in row['forecast_24h'][:23]]
            changes.append({'hour':i,'old_selected':previous['selected'],'new_selected':result['selected'],
                'old_temperature':previous['hvac_setpoint_c'],'new_temperature':command['hvac_setpoint_c'],
                'old_battery_kw':old['hours'][i]['storage']['power_kw'],'new_battery_kw':power,
                'manual_reference_count':len(result['manual_reference']),
                'old_metrics':previous['selection_reason']['metrics'][previous['selected']],
                'new_metrics':result['selection_reason']['metrics'][result['selected']]})
        align_export_segments(data);data=render_public_fields(data)
        assert categories(data)==categories(old)==expected[name]
        assert [(r['t'],r['abstain'],r['risk_score'],r['risk_threshold']) for r in data['hours']]==[(r['t'],r['abstain'],r['risk_score'],r['risk_threshold']) for r in old['hours']]
        main,detail=split_payload(data);raw=encode(main);detail['main_sha256']=hashlib.sha256(raw).hexdigest();validate_pair(main,detail,data)
        prepared[ROOT/(name+'.json')]=raw;prepared[ROOT/(name+'.agent-detail.json')]=encode(detail)
        report[name]={'source_counts_before':categories(old),'source_counts_after':categories(main),
            'current_gate_before':dict(Counter(r['agent']['status'] for r in old['hours'])),
            'current_gate_after':dict(Counter(r['agent']['status'] for r in main['hours'])),
            'forecast_gate_unchanged':True,'main_bytes':len(raw),'detail_bytes':len(encode(detail)),
            'added_main_agent_fields':sorted(set(main['hours'][0]['agent'])-set(json.loads((ROOT/(name+'.json')).read_bytes())['hours'][0]['agent'])),
            'added_candidate_summary_fields':sorted(set(main['hours'][0]['agent']['candidate_summaries'][0])-set(json.loads((ROOT/(name+'.json')).read_bytes())['hours'][0]['agent']['candidate_summaries'][0])),
            'control_metric_changes':changes}
    for p,raw in prepared.items():p.write_bytes(raw)
    hashes={p.name:sha(p) for p in prepared}
    receipt={'status':'passed','offline':True,'new_llm_calls':0,'new_dispatches':0,'schema_version':'1.5',
        'before_sha256':before_hash,'after_sha256':hashes,'scenarios':report,
        'source_note':'Historical saved prose attribution retained with host numeric edits; not a new LLM selection. Old prose/receipt provenance archived in detail llm. All controls recomputed by current host objective.',
        'ops_note':'Ops files untouched; their source hashes need coordinated refresh by Ops owner.'}
    Path('experiments/round77_export.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in receipt.items() if k!='scenarios'},ensure_ascii=False))


if __name__=='__main__':main()
