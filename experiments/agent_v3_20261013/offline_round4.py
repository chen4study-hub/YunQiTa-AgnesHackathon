"""Pre-freeze shape/grounding preflight. Old receipts are fixtures, NOT a rerun."""
import json,sys
from pathlib import Path
H=Path(__file__).resolve().parent;ROOT=H.parents[1];sys.path.insert(0,str(ROOT))
from evidence_contract import records_from_trace,canonical_records
from semantic_assertions import check
from src.agent.answer_grounding import numeric_issues
from src.agent.agent_tools import run_tool
from src.data.replay_payload import load_replay
import threading


def main():
    report={'fixture_only':True,'network_used':False,'exceptions':[],'counts':{},'raw_contract_positive_checks':[]}
    for kind,side in [('full','on'),('full','off'),('multi','on')]:
        old=json.loads((H/f'results/round3_{kind}_{side}.json').read_text(encoding='utf-8'))
        cases=json.loads((H/('round4_multi_cases.json' if kind=='multi' else 'round4_cases.json')).read_text(encoding='utf-8'))
        groups={};n=0
        for r in old['results']:
            c=cases[r['index']];d=load_replay(r.get('scenario','normal'));origin=d['hours'][r.get('origin_index',14)]['t']
            # Both paths' final traces always use identical raw adapter. Compare
            # on tapped-record shape as well, preserving full precision.
            records=records_from_trace(r.get('final_trace',[]),origin)
            if side=='on' and r.get('semantic_evidence'):
                canonical_records(r['semantic_evidence'],origin)
            if kind=='multi':
                records=groups.get(c['group'],[])+records;groups[c['group']]=records
            try:
                bool(check(c,r['answer'],records));n+=1
            except Exception as exc:report['exceptions'].append({'kind':kind,'side':side,'index':r['index'],'type':type(exc).__name__})
        report['counts'][kind+'_'+side]=n
    # Trusted numeric support cannot be manufactured from reference/display_values.
    from tests.test_agent_v3 import fixture
    d,row=fixture()
    for name,q,args in [('storage_history','储能充放电记录',{}),('energy_totals','前天用电',{'relative_day':-2}),('building_state','运行概览',{}),('elevator_state','电梯运行',{})]:
        rec=run_tool(name,args,d,row,'2026-10-13','14:00',2,threading.Event(),q)
        raw=records_from_trace(rec['trace'],row['t'])
        assert not numeric_issues(rec['reference'],raw),(name,numeric_issues(rec['reference'],raw))
        forged=[{**raw[0],'reference':'999999 元','evidence':{'display_values':[999999]}}]
        assert numeric_issues('999999 元',forged)
        report['raw_contract_positive_checks'].append(name)
    # Cover both shapes for ALL remaining cases without HTTP/model/network calls.
    # Use deterministic local tool results; public schemas are fixture-only.
    from src.agent.building_tools import NAMES
    for filename in ('round4_cases.json','round4_multi_cases.json'):
        cases=json.loads((H/filename).read_text(encoding='utf-8'))
        for c in cases:
            tool=c.get('tool')
            if tool in ('web_search','city_weather'):
                trace=[{'tool':tool,'result':{'status':'empty','recent_news':tool=='web_search','sources':[]}}]
                ref='没查到相关报道。' if tool=='web_search' else '上海天气暂时查不到。'
            elif tool:
                name='hvac_compare' if tool=='compare_costs' else tool
                args={'setpoint_c':24} if name=='hvac_compare' else {'floor':18} if name=='floor_state' else {}
                rec=run_tool(name,args,d,row,'2026-10-13','14:00',2,threading.Event(),c['question'])
                trace=rec['trace'];ref=rec['reference']
            else:trace=[];ref='暂无相关资料。'
            for shape in ('old_final','new_records'):
                records=(records_from_trace(trace,row['t']) if shape=='old_final' else canonical_records([{'success':True,'trace':trace}],row['t']))
                # A failed semantic check is legitimate; exceptions are not.
                bool(check(c,ref,records))
        report['counts'][filename+'_both_shapes']=len(cases)*2
    # Mixed list/dict public records from former off index65 no longer crash.
    rec=[{'tool':'city_weather','result':{'city':'上海','sources':[{'url':'https://api.open-meteo.com/v1/forecast','title':'Open-Meteo 上海天气'}]}}]
    assert check({'question':'上海天气怎么样'},'上海晴。',records_from_trace(rec,row['t']))
    assert not report['exceptions'],report['exceptions']
    report['passed']=True
    (H/'round4_offline.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':main()
