import re
import pytest
from tests.test_agent_orchestrator import fixtures
from src.agent.orchestrator import run_agent,check_grounding,candidate_evidence,reason_format_invalid


@pytest.mark.parametrize('text',['选择保持设定。','prepared interval upper 1200.0 kW','选择SOC合适的hold方案。','模拟保持1200.00千瓦上界。'])
def test_missing_upper_or_format_is_rendered_not_choice_fallback(text):
    f,c=fixtures()
    class Provider:
        count=0
        def choose_candidate(self,*a):
            self.count+=1
            return {'choice':{'candidate_id':'rule_hold','reason':text},'llm':{'mode':'real','reason':'call_succeeded'}}
    provider=Provider();r=run_agent(f,c,provider=provider,dispatch_enabled=False)
    assert r['source']=='llm' and provider.count==1 and r['selected']=='rule_hold'
    assert '按负荷上限 1,200.0 kW安排调度' in r['reason']
    assert not reason_format_invalid(r['reason']) and not re.search(r'\d+\.\d{2,}',r['reason'])
    assert not any(w in r['reason'] for w in ['影子','模拟','估算'])
    assert check_grounding(r['reason'],{'forecast':f,'candidates':candidate_evidence(r['candidates'])})


def test_template_never_hides_unsupported_numeric_token():
    f,c=fixtures()
    class Provider:
        count=0
        def choose_candidate(self,*a):
            self.count+=1
            return {'choice':{'candidate_id':'rule_hold','reason':'prepared interval upper 99999.999 kW'},'llm':{'mode':'real','reason':'call_succeeded'}}
    p=Provider();r=run_agent(f,c,provider=p,dispatch_enabled=False)
    assert p.count==1 and r['source']=='llm' and r['explanation_source']=='template'
    assert r['llm']['prose_repair']['unknown_numeric_sentences']==1
    assert '99999' not in r['reason']


def test_all259_real_paired_evidence_offline_summary():
    import json
    from pathlib import Path
    from scripts.regress_explanation_template import summarize
    plan=json.loads(Path('experiments/explanation_template_v1_plan.json').read_text())
    rows=[json.loads(l) for l in Path('experiments/explanation_template_v1_pairs.jsonl').read_text(encoding='utf-8').splitlines()]
    result=json.loads(Path('experiments/explanation_template_v1_summary.json').read_text())
    assert len(rows)==len(plan['pairs'])==259 and [r['index'] for r in rows]==list(range(259))
    assert [dict(date=r['date'],hour=r['hour']) for r in rows]==plan['pairs']
    assert summarize(rows)['arms']==result['arms'] and result['status']=='completed'
    assert result['arms']['before']['final_unsourced_numeric_tokens']==result['arms']['after']['final_unsourced_numeric_tokens']==0
