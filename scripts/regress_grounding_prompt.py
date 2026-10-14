"""Frozen paired prompt-only regression; real calls, no dispatch or provider bodies saved."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import types
from src.agent.orchestrator import run_agent,ungrounded_numbers,rounded_tools,candidate_evidence
from src.agent.provider import OpenAICompatibleProvider,get_llm_status,read_key

PLAN=Path('experiments/grounding_prompt_v1_plan.json')
ROWS=Path('experiments/grounding_prompt_v1_pairs.jsonl')
BINDING=Path('experiments/grounding_prompt_v1_binding.json')
SUMMARY=Path('experiments/grounding_prompt_v1_summary.json')


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def baseline(commit):
    # Trusted repository code at frozen commit; memory-only, no worktree/reset or env edits.
    old=subprocess.run(['git','show',commit+':src/agent/orchestrator.py'],capture_output=True,check=True).stdout.decode('utf-8')
    module=types.ModuleType('src.agent._grounding_prompt_baseline');module.__package__='src.agent'
    sys.modules[module.__name__]=module
    exec(compile(old,'<frozen baseline orchestrator>','exec'),module.__dict__)
    return module.run_agent,hashlib.sha256(old.encode()).hexdigest()


class Metered:
    def __init__(self):self.provider=OpenAICompatibleProvider();self.attempts=[]
    def choose_candidate(self,forecast,candidates,instruction):
        start=time.monotonic();r=self.provider.choose_candidate(forecast,candidates,instruction)
        missing=ungrounded_numbers(r.get('choice',{}).get('reason',''),{'forecast':forecast,'candidates':candidates})
        self.attempts.append(dict(mode=r['llm'].get('mode'),reason=r['llm'].get('reason'),
            error_type=r['llm'].get('error_type'),status_code=r['llm'].get('status_code'),
            unsourced_numeric_token_count=len(missing),elapsed_ms=round((time.monotonic()-start)*1000,1)))
        return r


def arm(fn,row):
    provider=Metered();start=time.monotonic()
    r=fn(row['forecast'],row['context'],row['constraints'],provider=provider,dispatch_enabled=False,dispatch_current_only=True)
    final_unsupported=len(ungrounded_numbers(r['reason'],{'forecast':rounded_tools(row['forecast']),'candidates':candidate_evidence(r['candidates'])}))
    assert final_unsupported==0 and r['receipt']['count']==0
    assert r['selected']==row['result']['selection_reason']['preferred_candidate_id']
    assert r['plan']==row['result']['plan']  # policy/control unchanged, only explanations
    return dict(source=r['source'],llm=r['llm'],selected=r['selected'],
        final_unsourced_numeric_token_count=final_unsupported,attempts=provider.attempts,
        elapsed_ms=round((time.monotonic()-start)*1000,1))


def summarize(rows):
    summary={'pairs':len(rows),'arms':{}}
    for label in ['before','after']:
        arms=[r[label] for r in rows];calls=[a for r in arms for a in r['attempts'] if a['reason']=='call_succeeded']
        first=[r['attempts'][0] for r in arms if r['attempts'] and r['attempts'][0]['reason']=='call_succeeded']
        failures=sum(r['llm'].get('reason')=='grounding_failed' for r in arms)
        summary['arms'][label]=dict(hours=len(arms),grounding_fallback_hours=failures,
            grounding_fallback_rate=failures/len(arms) if arms else None,
            final_reasons=dict(Counter(r['llm'].get('reason') for r in arms)),
            validated_real_hours=sum(r['source']=='llm' for r in arms),
            first_transport_successes=len(first),first_unsourced_drafts=sum(a['unsourced_numeric_token_count']>0 for a in first),
            first_unsourced_rate=sum(a['unsourced_numeric_token_count']>0 for a in first)/len(first) if first else None,
            successful_provider_drafts=len(calls),unsourced_provider_drafts=sum(a['unsourced_numeric_token_count']>0 for a in calls),
            unsupported_numeric_tokens=sum(a['unsourced_numeric_token_count'] for a in calls),
            final_unsourced_numeric_tokens=sum(r['final_unsourced_numeric_token_count'] for r in arms))
    summary['paired_transitions']=dict(Counter(('grounding_failed' if r['before']['llm'].get('reason')=='grounding_failed' else 'other')+' -> '+('grounding_failed' if r['after']['llm'].get('reason')=='grounding_failed' else 'other') for r in rows))
    return summary


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pairs',type=int,default=6);parser.add_argument('--report-only',action='store_true');args=parser.parse_args()
    plan=json.loads(PLAN.read_text(encoding='utf-8'));records=[json.loads(l) for l in Path(plan['source']).read_text(encoding='utf-8').splitlines()]
    if sha(plan['source'])!=plan['source_sha256']:raise ValueError('Source integrity changed')
    old,old_sha=baseline(plan['baseline_commit'])
    binding=dict(plan_sha256=sha(PLAN),baseline_orchestrator_sha256=old_sha,
        current_code_sha256={p:sha(p) for p in ['src/agent/orchestrator.py','src/agent/provider.py','src/agent/numeric_prompt.py','src/agent/selection.py','src/agent/tools.py','scripts/regress_grounding_prompt.py']})
    if BINDING.exists():
        if json.loads(BINDING.read_text())!=binding:raise ValueError('Code changed during frozen regression')
    else:BINDING.write_text(json.dumps(binding,indent=2),encoding='utf-8')
    saved=[json.loads(l) for l in ROWS.read_text(encoding='utf-8').splitlines()] if ROWS.exists() else []
    if [r['index'] for r in saved]!=list(range(len(saved))):raise ValueError('Checkpoint has gaps/duplicates')
    if not args.report_only:
        if get_llm_status()['mode']!='real':raise RuntimeError('Requires existing real runtime configuration')
        selected=plan['pairs'][len(saved):len(saved)+args.pairs]
        def pair(item):
            i=plan['pairs'].index(item);row=next(r for r in records if r['date']==item['date'] and r['hour']==item['hour'])
            result=dict(index=i,date=item['date'],hour=item['hour'],historical_reason=row['result']['llm']['reason'],order=['before','after'] if i%2==0 else ['after','before'])
            for label in result['order']:result[label]=arm(old if label=='before' else run_agent,row)
            return result
        with ThreadPoolExecutor(max_workers=2) as pool:
            for row in pool.map(pair,selected):
                text=json.dumps(row,ensure_ascii=False,allow_nan=False,separators=(',',':'));key,_=read_key()
                if key and key in text:raise ValueError('Credential safety check failed')
                with ROWS.open('a',encoding='utf-8') as f:f.write(text+'\n')
                saved.append(row)
                print(json.dumps(dict(pair=row['index'],before=row['before']['llm']['reason'],after=row['after']['llm']['reason'])),flush=True)
    summary=summarize(saved);summary['status']='completed' if len(saved)==len(plan['pairs']) else 'paused'
    summary['historical_sample_reasons']=dict(Counter(r['historical_reason'] for r in saved))
    SUMMARY.write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary),flush=True)


if __name__=='__main__':main()
