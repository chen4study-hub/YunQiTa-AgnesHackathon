from src.data.replay_payload import load_replay
import json
from pathlib import Path
import numpy as np
from src.agent.confidence import gate_confidence


def test_replay_confidence_matches_past_validation_bins():
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    for name in ('normal','peak','abstain'):
        d=load_replay(name)
        item=next(x for x in index['rows'] if x['month']==d['meta']['date'][:7])
        lookup=item['confidence_lookup']
        assert np.all(np.diff(lookup['coverage'])<=1e-10)
        for h in d['hours']:
            score,threshold=gate_confidence(lookup,h['risk_score'],h['risk_threshold'],h['abstain'])
            assert h['confidence']==score and d['meta']['confidence_threshold']==threshold
            assert h['abstain']==(h['confidence']<threshold)
        assert len(set(h['confidence'] for h in d['hours']))>1
    peak=load_replay('peak')
    assert peak['meta']['date'][5:7] in ('07','08')
    assert max(h['outdoor_temp_c'] for h in peak['hours'])>=30
    assert any(12<=int(h['t'][11:13])<18 and h['storage']['power_kw']>0 and not h['abstain'] for h in peak['hours'])


def test_plateau_risk_and_width_rejection_are_unambiguous():
    lookup={'centers':[0.,1.],'coverage':[.9,.9]}
    scores=[gate_confidence(lookup,r,.8,False)[0] for r in (.1,.2,.3)]
    assert scores[0]>scores[1]>scores[2]
    for r,rejected in ((.1,True),(.8,False),(.81,True)):
        score,t=gate_confidence(lookup,r,.8,rejected)
        assert rejected==(score<t)
