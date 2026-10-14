"""Re-export existing verified Agent wording only; no provider, dispatch or model rerun."""
import hashlib,json
from pathlib import Path
from jsonschema import Draft202012Validator
from src.agent.display_text import public_text,display_evidence,wording_text,render_public_fields,restore_host_clocks
from src.agent.orchestrator import check_grounding


def refresh(data):
    counts=0
    old=data['energy_summary']['label']
    data['energy_summary']['label']=wording_text(old)
    counts+=int(data['energy_summary']['label']!=old)
    for row in data['hours']:
        a=row['agent'];origin=row['t'];evidence=display_evidence({'forecast':row['forecast_24h'],'agent':a},origin)
        def rewrite(obj,key):
            nonlocal counts
            old=obj[key];new=render_public_fields({'text':public_text(restore_host_clocks(old),origin,evidence)})['text']
            if old!=new:counts+=1
            obj[key]=new
        try:rewrite(a,'explanation')
        except ValueError:
            # Do not guess a day for ambiguous LLM clock prose. Preserve selected
            # controls, but disclose host-only wording through existing provenance.
            upper=max([row['upper_kw']]+[p['upper_kw'] for p in row['forecast_24h'][:23]])
            a['explanation']=public_text(f'按区间上界 {upper:.1f} kW准备。'+a['selection_reason']['summary'],origin,evidence)
            a['explanation_source']='template';a['llm']['explanation_mode']='template';counts+=1
        for action in range(len(a['actions'])):a['actions'][action]=render_public_fields({'text':public_text(restore_host_clocks(a['actions'][action]),origin,evidence)})['text']
        if 'selection_reason' in a:rewrite(a['selection_reason'],'summary')
        for c in a.get('candidates',[]):
            rewrite(c['selection_reason'],'summary')
            for p in c['plan']:rewrite(p,'reason')
        for w in a.get('work_orders',[]):
            for key in ('possible_reasons','suggested_checks'):
                w[key]=[render_public_fields({'text':public_text(restore_host_clocks(s),origin,evidence)})['text'] for s in w.get(key,[])]
        if a.get('candidates') and not check_grounding(a['explanation'],evidence):raise ValueError('Re-export display is not grounded')
    return counts


def main():
    validator=Draft202012Validator(json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8')))
    prepared=[];counts={}
    for name in ['normal','peak','abstain','sample']:
        p=Path(f'exports/replay/{name}.json');data=json.loads(p.read_text(encoding='utf-8'))
        counts[name]=refresh(data);validator.validate(data)
        prepared.append((p,json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False)))
    for p,s in prepared:p.write_text(s,encoding='utf-8')
    card_path=Path('exports/model_card.json');card=json.loads(card_path.read_text(encoding='utf-8'))
    for summary in card['hvac_attribution']['typical_day_summaries'].values():
        summary['label']=wording_text(summary['label'])
    card_path.write_text(json.dumps(card,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p,_ in prepared}
    for name in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{name}.json');r=json.loads(p.read_text(encoding='utf-8'))
        r['export_sha256']={k:hashes[k] for k in r['export_sha256']}
        from collections import Counter
        scenarios={p.stem:json.loads(s) for p,s in prepared if p.stem!='sample'}
        if name=='agent_replay_export':
            r['explanation_categories_by_scenario']={n:dict(Counter('rule' if h['agent']['source']=='rule' else h['agent']['explanation_source'] for h in d['hours'])) for n,d in scenarios.items()}
        r['display_text_refresh']={'units':'grouped number SPACE kW/kWh/元/°C; number%','dates':'今天 HH:MM / 次日 HH:MM','new_llm_calls':0,'controls_preserved':True}
        p.write_text(json.dumps(r,indent=2),encoding='utf-8')
    receipt={'status':'passed','rewritten_text_fields':counts,'export_sha256':hashes,'new_llm_calls':0,'new_dispatches':0,'controls_preserved':True}
    Path('experiments/grouped_display_refresh.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt))


if __name__=='__main__':main()
