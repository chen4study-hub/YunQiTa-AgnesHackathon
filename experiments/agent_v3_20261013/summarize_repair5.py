"""Summarize saved repair5 receipts; never rerun requests or rescore answers."""
import hashlib,json,math,statistics,sys
from pathlib import Path
H=Path(__file__).resolve().parent;ROOT=H.parents[1]
sys.path.insert(0,str(ROOT))
from experiments.agent_v3_20261013.summarize_round4 import supplemented,timeouts


def main():
    manifest_path=H/'repair5_freeze.json'
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    digest=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    drift=[p for p,v in manifest['hashes'].items() if hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=v]
    # Emergency search hotfix was separately committed AFTER all 60 queries.
    # Preserve historical manifest rather than pretending today's tree is frozen.
    assert drift==['src/agent/agent_relevance.py'],drift
    review=json.loads((H/'repair5_manual_review.json').read_text(encoding='utf-8'))
    summary={'manifest_sha256':digest,'frozen_files':len(manifest['hashes']),
             'post_run_drift':drift,'post_run_change_commit':'dc6ed8f',
             'note':'No requests rerun or automatic false upgraded. Hash equality was verified immediately after all batches; current drift is disclosed.',
             'runs':{}}
    for kind in ('full','multi'):
        for side in ('on','off'):
            key=kind+'_'+side;path=H/f'results/repair5_{key}.json'
            receipt=json.loads(path.read_text(encoding='utf-8'));rs=receipt['results'];n=10 if kind=='full' else 20
            assert receipt['complete'] and len(rs)==n and [r['index'] for r in rs]==list(range(n))
            assert receipt['source_hash']['frozen_manifest']==digest
            assert receipt['owned_backend_stopped'] and receipt['background_classifiers_stopped']
            assert all(r['pipeline_captured'] and not r.get('scoring_error') and not r['error'] for r in rs)
            deducted={r['index'] for r in review[key]}
            assert len(deducted)==len(review[key]) and all(rs[i]['correct_with_evidence'] for i in deducted)
            assert all(r['quote'] in rs[r['index']]['answer'] for r in review[key])
            passed=[r['correct_with_evidence'] and r['index'] not in deducted for r in rs]
            is_model=lambda r:r['done'].get('mode')=='llm' and r['done'].get('explanation_source')=='llm'
            times=sorted(r['duration_ms']/1000 for r in rs);worst=max(rs,key=lambda r:r['duration_ms'])
            tc=[timeouts(r,side) for r in rs]
            value={'count':n,'automatic':sum(r['correct_with_evidence'] for r in rs),'deducted':len(deducted),'after_review':sum(passed),
                   'model_text':sum(is_model(r) for r in rs),'model_self':sum(is_model(r) and not supplemented(r) for r in rs),
                   'model_plus_host':sum(is_model(r) and supplemented(r) for r in rs),
                   'templates':sum(r['template_answer'] for r in rs),'median_seconds':statistics.median(times),
                   'p90_seconds':times[math.ceil(.9*n)-1],'max_seconds':max(times),'slowest_index':worst['index'],'slowest_question':worst['question'],
                   'empty_answers':sum(not r['answer'].strip() for r in rs),'over_25_seconds':sum(r['duration_ms']>25000 for r in rs),
                   'timeout_counts':{k:sum(t[k] for t in tc) for k in tc[0]},
                   'timeout_cases':[{'index':r['index'],'question':r['question'],'llm_reason':r['done'].get('llm_reason'),**t} for r,t in zip(rs,tc) if t['total']],
                   'false_indices':[r['index'] for r in rs if not r['correct_with_evidence']],'deducted_indices':sorted(deducted),
                   'receipt_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'batches':len(receipt['owned_ports'])}
            if kind=='multi':
                groups=[]
                for i in range(0,n,2):
                    assert rs[i]['group']==rs[i+1]['group']
                    groups.append({'group':rs[i]['group'],'automatic':bool(rs[i]['correct_with_evidence'] and rs[i+1]['correct_with_evidence']),
                                   'after_review':bool(passed[i] and passed[i+1]),
                                   'both_model_self':all(is_model(rs[j]) and not supplemented(rs[j]) for j in (i,i+1))})
                value.update(groups=groups,automatic_groups=sum(g['automatic'] for g in groups),reviewed_groups=sum(g['after_review'] for g in groups),model_self_groups=sum(g['both_model_self'] for g in groups))
            summary['runs'][key]=value
    (H/'repair5_summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    for key,v in summary['runs'].items():
        print(key,json.dumps({k:v[k] for k in v if k not in ('groups','receipt_sha256')},ensure_ascii=False))

if __name__=='__main__':main()
