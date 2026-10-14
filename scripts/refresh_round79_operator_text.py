"""Narrow offline public-prose cleanup; preserve controls/numbers/source attribution."""
import copy
import hashlib
import json
from pathlib import Path
from src.data.replay_payload import load_replay,split_payload,hydrate_hour
from src.agent.display_text import PUBLIC_TEXT_FIELDS,operator_spacing,unit_text,number_text
from scripts.compact_replay import encode,validate_pair
from scripts.refresh_live_display import without_prose,categories

ROOT=Path('exports/replay')
OUT=Path('experiments/round79_wording_export.json')


def clean(text):
    text=text.replace('相对基准上界削峰','比常规运行的高峰低')
    text=text.replace('需人工复核','交值班人员处理').replace('需要人工复核','交值班人员处理')
    return operator_spacing(number_text(unit_text(text)))


def clean_live(obj,key=''):
    if isinstance(obj,dict):return {k:(copy.deepcopy(v) if k=='llm' else clean_live(v,k)) for k,v in obj.items()}
    if isinstance(obj,list):return [clean_live(v,key) for v in obj]
    if isinstance(obj,str) and key in PUBLIC_TEXT_FIELDS:return clean(obj)
    return obj


def sha(raw):return hashlib.sha256(raw).hexdigest()


def run():
    if OUT.exists():raise FileExistsError('round79 prose already refreshed')
    prepared={};records={}
    for scenario in ('normal','peak','abstain'):
        old=load_replay(scenario);new=clean_live(old)
        assert without_prose(old)==without_prose(new),'non-prose fields changed'
        assert categories(old)==categories(new)
        for before,after in zip(old['hours'],new['hours']):assert before['agent']['llm']==after['agent']['llm'],'history changed'
        main,detail=split_payload(new);raw=encode(main);detail['main_sha256']=sha(raw)
        validate_pair(main,detail,new)
        restored=copy.deepcopy(main);restored['hours']=[hydrate_hour(main,r,detail) for r in main['hours']]
        restored['meta']={**detail['origin_metadata'],'agent_detail_file':main['meta']['agent_detail_file']}
        again,again_detail=split_payload(restored);again_detail['main_sha256']=detail['main_sha256']
        assert encode(again)==raw and encode(again_detail)==encode(detail)
        changed=sum(a['agent']['explanation']!=b['agent']['explanation'] for a,b in zip(old['hours'],new['hours']))
        records[scenario]=dict(source_counts_before=categories(old),source_counts_after=categories(new),explanation_hours_changed=changed,
            refused_hours=[i for i,h in enumerate(new['hours']) if h['abstain']])
        for suffix,data in [('.json',raw),('.agent-detail.json',encode(detail))]:
            path=ROOT/(scenario+suffix);records[scenario][suffix]=dict(before_sha256=sha(path.read_bytes()),after_sha256=sha(data),bytes=len(data));prepared[path]=data
    for path,raw in prepared.items():path.write_bytes(raw)
    # Existing receipts retain historic records; add this new refresh and update
    # current pointer hashes only. Historical round78 evidence stays immutable.
    for name in ('agent_replay_export','future24_export'):
        p=Path('experiments')/(name+'.json');r=json.loads(p.read_text(encoding='utf-8'))
        r['export_sha256']={p.name:sha(raw) for p,raw in prepared.items() if '.agent-detail.' not in p.name}
        r['agent_detail_sha256']={p.name:sha(raw) for p,raw in prepared.items() if '.agent-detail.' in p.name}
        r['round79_operator_text']={'receipt':str(OUT).replace('\\','/'),'new_llm_calls':0,'new_dispatches':0,'nonprose_unchanged':True}
        if name=='agent_replay_export':r['explanation_categories_by_scenario']={n:r['source_counts_after'] for n,r in records.items()}
        p.write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8')
    result=dict(status='passed',schema_version='1.5',source_main_commit='58c7142',scenarios=records,
        new_llm_calls=0,new_dispatches=0,nonprose_unchanged=True,exact_runtime_roundtrip=True,pair_idempotent=True,
        llm_audit_unchanged=True,ops_regeneration_required=True,ops_files_changed=False,
        replacements=['number/unit/Chinese spacing','相对基准上界削峰→比常规运行的高峰低','需人工复核→交值班人员处理'])
    OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':run()
