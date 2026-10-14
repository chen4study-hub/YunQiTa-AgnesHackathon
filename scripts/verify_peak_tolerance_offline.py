"""No network/provider/dispatch: replay saved v4 inputs against final host code."""
import copy,json
from collections import Counter
from pathlib import Path
from scripts.download_bdg2_thermal import sha
from scripts.report_peak_tolerance import binding_matches
from src.agent.orchestrator import run_agent,check_grounding
from src.agent.selection import misleading_tradeoff
from src.agent.display_text import display_evidence


class HostOnly:
    def choose_candidate(self,f,c,instruction):
        best=next(a for a in c if a['selection_reason']['objective_optimal'])
        return {'choice':{'candidate_id':best['candidate_id'],'reason':'选择已通过约束与目标检查的候选。'},'llm':{'mode':'demo','reason':'offline_validation'}}


def main():
    binding=json.loads(Path('experiments/agent_eval_v4_binding.json').read_text())
    snapshot='experiments/agent_eval_v4_selection_snapshot.py'
    assert sha(snapshot)==binding['code_sha256']['src/agent/selection.py']
    assert all(binding_matches(p,s) for p,s in binding['code_sha256'].items() if p!='src/agent/selection.py')
    rows=[json.loads(l) for l in Path('experiments/agent_eval_v4_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    count=0
    for row in rows:
        old=row['result'];new=run_agent(copy.deepcopy(row['forecast']),copy.deepcopy(row['context']),copy.deepcopy(row['constraints']),provider=HostOnly(),dispatch_enabled=False)
        assert new['selected']==old['selected']
        controls=lambda a:[{k:p[k] for k in ['timestamp','hvac_setpoint_c','battery_kw','action']} for p in a['plan']]
        assert controls(new)==controls(old)
        assert new['selection_reason']['summary']==old['selection_reason']['summary']
        # Test actual saved real-LLM wording against the final exact host band/gain.
        assert not misleading_tradeoff(old['reason'],new['selection_reason'])
        count+=1
    categories={};hashes={};screened=0
    for name in ['normal','peak','abstain']:
        p=Path(f'exports/replay/{name}.json');d=json.loads(p.read_text(encoding='utf-8'))
        for r in d['hours']:
            a=r['agent'];evidence=display_evidence({'forecast':r['forecast_24h'],'agent':a},r['t'])
            assert not misleading_tradeoff(a['explanation'],a['selection_reason'])
            assert check_grounding(a['explanation'],evidence)
            screened+=1
        categories[name]=dict(Counter('rule' if r['agent']['source']=='rule' else r['agent']['explanation_source'] for r in d['hours']))
        hashes[p.name]=sha(p)
    result={'status':'passed','saved_eval_hours':count,'controls_and_host_summary_identical':True,'saved_real_wording_passes_final_guard':True,'export_hours_screened':screened,'export_sha256':hashes,'export_wording_categories':categories,'export_mutations':0,'new_llm_calls':0,'new_dispatches':0,'selection_evaluated_snapshot_sha256':sha(snapshot),'selection_final_sha256':sha('src/agent/selection.py'),'independent_subagent_status':'failed; no independent pass claimed'}
    Path('experiments/peak_tolerance_offline_validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
