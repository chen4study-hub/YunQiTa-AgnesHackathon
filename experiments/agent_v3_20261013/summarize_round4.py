"""Read-only summary from frozen receipts + same-rule manual deductions."""
import json,math,statistics,hashlib,sys
from pathlib import Path
H=Path(__file__).resolve().parent;ROOT=H.parents[1]
sys.path.insert(0,str(ROOT))


def model_text(r):
    return r['done'].get('explanation_source')=='llm'


def supplemented(r):
    from src.agent.building_tools import NAMES
    phases=r['done'].get('phase_timings',[])
    # Old composite route emits deterministic building records alongside a
    # streamed legacy answer, without setting host_supplemented for that join.
    mixed_route=any(p.get('phase')=='answer_stream' for p in phases) and any(t.get('tool') in NAMES for t in r.get('final_trace',[]))
    return bool(mixed_route or any(p.get('host_supplemented') for p in phases))


def timeouts(r,side):
    calls=r['upstream_calls'];first=total=transport=0
    if side=='on':
        first=sum(c.get('error')=='first_token_timeout' for c in calls)
        total=sum(c.get('error')=='agent_deadline' for c in calls)
    else:
        for c in calls:
            status=c.get('status',{})
            transport+=sum(a.get('error_type') in ('TimeoutError','ReadTimeout','ConnectTimeout','PoolTimeout','WriteTimeout') for a in status.get('transport_attempts',[]))
        # Legacy generator is cancelled at the host first/whole deadline before
        # a transport status exists. Count that call once, not as a second error.
        phases=r['done'].get('phase_timings',[])
        first=sum(p.get('reason')=='chat_first_token_timeout' for p in phases)
        total=sum(p.get('reason') in ('chat_deadline_or_busy','chat_deadline') for p in phases)
        # "or_busy" ambiguous in general; this receipt's stream first_token exists
        # and elapsed~30s, proving deadline rather than slot-busy. Exclude otherwise.
        if total and not any(c.get('phase')=='legacy_answer_stream' and c.get('first_response_ms') is not None and c.get('total_ms',0)>=29900 for c in calls):total=0
    return {'first_response':first,'whole_call':total,'transport_timeout':transport,'total':first+total+transport}


def main():
    freeze=json.loads((H/'round4_freeze.json').read_text(encoding='utf-8'))
    assert all(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==v for f,v in freeze['hashes'].items())
    review=json.loads((H/'round4_manual_review.json').read_text(encoding='utf-8'))
    summary={'frozen_manifest_sha256':hashlib.sha256((H/'round4_freeze.json').read_bytes()).hexdigest(),'frozen_files':len(freeze['hashes']),'all_hashes_unchanged':True,'runs':{}}
    for kind in ('full','multi'):
        for side in ('on','off'):
            key=kind+'_'+side;d=json.loads((H/f'results/round4_{key}.json').read_text(encoding='utf-8'));rs=d['results'];n=91 if kind=='full' else 20
            assert d['complete'] and len(rs)==n and [r['index'] for r in rs]==list(range(n))
            assert d['owned_backend_stopped'] and d['background_classifiers_stopped'] and all(r['pipeline_captured'] and not r.get('scoring_error') for r in rs)
            deductions={r['index'] for r in review[key]};assert all(rs[i]['correct_with_evidence'] for i in deductions)
            passed=[r['correct_with_evidence'] and r['index'] not in deductions for r in rs]
            times=sorted(r['duration_ms']/1000 for r in rs);worst=max(rs,key=lambda r:r['duration_ms']);tc=[timeouts(r,side) for r in rs]
            value={'count':n,'automatic':sum(r['correct_with_evidence'] for r in rs),'deducted':len(deductions),'after_review':sum(passed),
                   'model_text_count':sum(model_text(r) for r in rs),'model_self_count':sum(model_text(r) and not supplemented(r) for r in rs),
                   'model_plus_host':sum(model_text(r) and supplemented(r) for r in rs),
                   'model_pass_after_review':sum(p and model_text(r) for p,r in zip(passed,rs)),
                   'templates':sum(r['template_answer'] for r in rs),'median_seconds':statistics.median(times),'p90_seconds':times[math.ceil(.9*n)-1],
                   'max_seconds':max(times),'slowest_index':worst['index'],'slowest_question':worst['question'],
                   'upstream_timeouts':{k:sum(t[k] for t in tc) for k in tc[0]},'timeout_affected_cases':sum(t['total']>0 for t in tc),
                   'empty_answers':sum(not r['answer'] for r in rs),'over_25_seconds':sum(r['duration_ms']>25000 for r in rs),
                   'receipt_sha256':hashlib.sha256((H/f'results/round4_{key}.json').read_bytes()).hexdigest(),'saved_batches':len(d['owned_ports']),
                   'false_indices':[r['index'] for r in rs if not r['correct_with_evidence']],'deducted_indices':sorted(deductions)}
            if kind=='multi':
                value.update(automatic_groups=sum(rs[i]['correct_with_evidence'] and rs[i+1]['correct_with_evidence'] for i in range(0,n,2)),
                             reviewed_groups=sum(passed[i] and passed[i+1] for i in range(0,n,2)),
                             model_self_groups=sum(all(model_text(rs[j]) and not supplemented(rs[j]) for j in (i,i+1)) for i in range(0,n,2)))
            summary['runs'][key]=value
    (H/'round4_summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
