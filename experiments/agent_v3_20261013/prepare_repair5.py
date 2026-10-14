"""Subset + offline scorer regression; does not mutate any previous receipt."""
import json,sys,hashlib
from pathlib import Path
H=Path(__file__).resolve().parent;ROOT=H.parents[1];sys.path.insert(0,str(ROOT))
from experiments.agent_v3_20261013.evidence_contract import records_from_trace,canonical_records
from experiments.agent_v3_20261013.semantic_assertions import check
from experiments.agent_v3_20261013.probe import evaluate


def main():
    full=json.loads((H/'round4_cases.json').read_text(encoding='utf-8'))
    indices=[17,21,37,75,80,84,85,90]
    cases=[full[i] for i in indices]
    cases += json.loads((H/'hotfix_cases.json').read_text(encoding='utf-8'))
    (H/'repair5_cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
    (H/'repair5_multi_cases.json').write_bytes((H/'round4_multi_cases.json').read_bytes())
    checks=[]
    # Existing failure receipts are offline fixtures only, not new acceptance.
    for kind,side,i in [('full','off',21),('full','off',84),('full','off',85),('full','off',90),('multi','on',6),('multi','on',7)]:
        old=json.loads((H/f'results/round4_{kind}_{side}.json').read_text(encoding='utf-8'))['results'][i]
        case=full[i] if kind=='full' else json.loads((H/'round4_multi_cases.json').read_text(encoding='utf-8'))[i]
        records=old['semantic_evidence']
        semantic=check(case,old['answer'],records)
        baseline=evaluate(case,old['answer'],old['tools'],old['done'],[],old['duration_ms'],old['final_trace'])
        assert semantic and baseline,(kind,side,i,semantic,baseline)
        checks.append({'fixture':f'round4_{kind}_{side}','index':i,'semantic':semantic,'evaluate':baseline})
    # Both canonical projections retain the same raw data and scoring outcome.
    from tests.test_agent_v3 import fixture
    from src.agent.agent_tools import run_tool
    import threading
    d,r=fixture()
    for name,q in [('elevator_state','L1电梯在哪层'),('building_state','现在的总负荷是多少')]:
        rec=run_tool(name,{},d,r,'2026-10-13','14:00',2,threading.Event(),q)
        off=records_from_trace(rec['trace'],r['t']);on=canonical_records([rec],r['t'])
        case=full[21 if name=='elevator_state' else 90]
        assert check(case,rec['reference'],off)==check(case,rec['reference'],on)==True
        assert not check(case,'L1 停靠2层，L3停靠20层。' if name=='elevator_state' else '总负荷 114.3 kW。',off)
        checks.append({'raw_shape_equivalence':name,'positive':True,'negative':True})
    (H/'repair5_offline.json').write_text(json.dumps({'checks':checks,'network_calls':0,'exceptions':[],'note':'not new online scores; original round4 untouched'},ensure_ascii=False,indent=2),encoding='utf-8')
    print('offline checks',len(checks),'passed; cases',len(cases),'multi',20)

if __name__=='__main__':main()
