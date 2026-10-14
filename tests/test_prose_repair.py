import pytest
from src.agent.prose_repair import repair_prose
from src.agent.orchestrator import check_grounding,run_agent
from src.agent.display_text import display_evidence
from tests.test_storage_rolling import inputs

ORIGIN='2017-10-23T12:00:00-05:00'


@pytest.mark.parametrize('text,want',[
    ('费用16554.84元。保留电量供峰段调度。','费用 16,554.8 元。保留电量供峰段调度。'),
    ('费用16,554.8元。保留电量供峰段调度。','费用 16,554.8 元。保留电量供峰段调度。'),
    ('费用9999.9元。保留电量供峰段调度。','保留电量供峰段调度。'),
    ('费用12,34元。保留电量供峰段调度。','保留电量供峰段调度。'),
    ('费用16554.7元。保留电量供峰段调度。','保留电量供峰段调度。'),
    ('费用9999.9元。','')])
def test_normalize_only_allowlisted_rounding_otherwise_drop_whole_sentence(text,want):
    e=display_evidence({'cost':16554.8},ORIGIN);out,stats=repair_prose(text,ORIGIN,e)
    assert out==want and check_grounding(out,e)


def test_unknown_date_sentence_removed_not_reassigned():
    e=display_evidence({'timestamp':'2017-10-24T13:00:00-05:00'},ORIGIN)
    out,stats=repair_prose('2017年10月25日13时准备。保留储能以备后续使用。',ORIGIN,e)
    assert out=='保留储能以备后续使用。' and stats['dropped_sentences']==1


def test_surviving_real_sentence_has_llm_provenance_and_no_recall():
    f,c,k=inputs('normal',14)
    class P:
        calls=0
        def choose_candidate(self,forecast,candidates,instruction):
            self.calls+=1;best=next(a for a in candidates if a['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':best['candidate_id'],'reason':'预计收益999999.9元。保留电量供后续调度，保持当前设定。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    p=P();r=run_agent(f,c,k,provider=p,dispatch_enabled=False)
    assert p.calls==1 and r['source']=='llm' and r['explanation_source']=='llm'
    assert '999999' not in r['reason'] and '保留电量供后续调度' in r['reason']
    assert r['llm']['prose_repair']['unknown_numeric_sentences']==1
