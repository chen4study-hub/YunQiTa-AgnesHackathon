"""Same259 accepted hours, old/new real paired calls; no dispatch/raw prose logs."""
import argparse,json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from scripts.regress_grounding_prompt import baseline,arm,sha
from src.agent.orchestrator import run_agent
from src.agent.provider import get_llm_status,read_key

PLAN=Path('experiments/explanation_template_v1_plan.json')
ROWS=Path('experiments/explanation_template_v1_pairs.jsonl')
BINDING=Path('experiments/explanation_template_v1_binding.json')
SUMMARY=Path('experiments/explanation_template_v1_summary.json')
CODE=['scripts/regress_explanation_template.py','scripts/regress_grounding_prompt.py','src/agent/orchestrator.py','src/agent/selection.py','src/agent/storage_planner.py','src/agent/tools.py','src/agent/provider.py','src/agent/numeric_prompt.py']


def summarize(rows):
    output={'pairs':len(rows),'arms':{}}
    for label in ['before','after']:
        arms=[r[label] for r in rows];failed=[r for r in arms if r['source']!='llm']
        output['arms'][label]=dict(hours=len(arms),validated_real_hours=len(arms)-len(failed),fallback_hours=len(failed),
            fallback_rate=len(failed)/len(arms) if arms else None,fallback_reasons=dict(Counter(r['llm']['reason'] for r in failed)),
            final_unsourced_numeric_tokens=sum(r['final_unsourced_numeric_token_count'] for r in arms),
            provider_calls=sum(len(r['attempts']) for r in arms),template_prose_hours=sum(r['llm'].get('explanation_mode')=='template' for r in arms))
    output['paired_transitions']=dict(Counter(('llm' if r['before']['source']=='llm' else 'fallback')+' -> '+('llm' if r['after']['source']=='llm' else 'fallback') for r in rows))
    return output


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pairs',type=int,default=20);parser.add_argument('--report-only',action='store_true');args=parser.parse_args()
    plan=json.loads(PLAN.read_text());assert sha(plan['source'])==plan['source_sha256']
    records={(r['date'],r['hour']):r for r in [json.loads(l) for l in Path(plan['source']).read_text(encoding='utf-8').splitlines()]}
    old,oldsha=baseline(plan['baseline_commit'])
    binding=dict(plan_sha256=sha(PLAN),baseline_sha256=oldsha,code_sha256={p:sha(p) for p in CODE})
    if BINDING.exists():assert json.loads(BINDING.read_text())==binding,'Frozen code changed'
    else:BINDING.write_text(json.dumps(binding,indent=2),encoding='utf-8')
    saved=[json.loads(l) for l in ROWS.read_text(encoding='utf-8').splitlines()] if ROWS.exists() else []
    assert [r['index'] for r in saved]==list(range(len(saved)))
    if not args.report_only:
        assert get_llm_status()['mode']=='real'
        subset=list(enumerate(plan['pairs']))[len(saved):len(saved)+args.pairs]
        def pair(entry):
            i,item=entry;record=records[item['date'],item['hour']]
            result=dict(index=i,**item,order=['before','after'] if i%2==0 else ['after','before'])
            for label in result['order']:result[label]=arm(old if label=='before' else run_agent,record)
            return result
        with ThreadPoolExecutor(max_workers=4) as pool:
            for row in pool.map(pair,subset):
                text=json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':'));key,_=read_key();assert not key or key not in text
                with ROWS.open('a',encoding='utf-8') as f:f.write(text+'\n')
                saved.append(row)
    summary=summarize(saved);summary['status']='completed' if len(saved)==len(plan['pairs']) else 'paused'
    SUMMARY.write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps(summary),flush=True)


if __name__=='__main__':main()
