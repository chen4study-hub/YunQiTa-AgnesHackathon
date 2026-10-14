"""Public-text-only export refresh; no provider, optimization, evaluation or dispatch."""
import copy,json,hashlib,subprocess
from collections import Counter
from pathlib import Path
from jsonschema import Draft202012Validator
from scripts.refresh_display_text import refresh
from src.agent.display_text import render_public_fields,PUBLIC_TEXT_FIELDS,BANNED_USER_WORDS,CALENDAR_NAMES


def sha(data):return hashlib.sha256(data).hexdigest()


def without_prose(obj,key=''):
    if isinstance(obj,dict):return {k:without_prose(v,k) for k,v in obj.items()}
    if isinstance(obj,list):return [without_prose(v,key) for v in obj]
    if isinstance(obj,str) and key in PUBLIC_TEXT_FIELDS:return '<public prose>'
    return obj


def categories(data):
    return dict(Counter('rule' if h['agent']['source']=='rule' else h['agent']['explanation_source'] for h in data['hours']))


def main():
    schema=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    validator=Draft202012Validator(schema);changes={};prepared={};before_hash={};texts=0
    for path in Path('exports').rglob('*.json'):
        raw=path.read_bytes();old=json.loads(raw);new=copy.deepcopy(old)
        before_hash[str(path).replace('\\','/')]=sha(raw)
        if path.parent.name=='replay' and path.stem in ('normal','peak','abstain','sample'):
            refresh(new)
        new=render_public_fields(new)
        # Fail rather than conceal any source/control/economics/provenance change.
        assert without_prose(new)==without_prose(old),str(path)
        n=0
        def scan(o,key='',previous=None):
            nonlocal n,texts
            if isinstance(o,dict):
                for k,v in o.items():scan(v,k,previous[k])
            elif isinstance(o,list):
                for v,p in zip(o,previous):scan(v,key,p)
            elif isinstance(o,str) and key in PUBLIC_TEXT_FIELDS:
                texts+=1;n+=o!=previous
                assert not any(w in o for w in BANNED_USER_WORDS) and not CALENDAR_NAMES.search(o),(str(path),key)
        scan(new,previous=old)
        if path.parent.name=='replay' and path.stem in ('normal','peak','abstain','sample'):validator.validate(new)
        if n:
            changes[str(path).replace('\\','/')]=n
            prepared[path]=json.dumps(new,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
    # All validation finishes before replacing any export.
    for path,raw in prepared.items():path.write_bytes(raw)
    hashes={f'{name}.json':sha(Path(f'exports/replay/{name}.json').read_bytes()) for name in ['normal','peak','abstain']}
    current={name:json.loads(Path(f'exports/replay/{name}.json').read_text(encoding='utf-8')) for name in ['normal','peak','abstain']}
    for name in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{name}.json');r=json.loads(p.read_text(encoding='utf-8'))
        r['export_sha256']={k:hashes[k] for k in r['export_sha256']}
        if name=='agent_replay_export':r['explanation_categories_by_scenario']={n:categories(d) for n,d in current.items()}
        r['live_display_refresh']={'new_llm_calls':0,'new_dispatches':0,'controls_economics_and_sources_preserved':True,'dates':'今天 HH:MM / 次日 HH:MM; optional display_date host decoration only','receipt':'experiments/live_display_refresh.json'}
        p.write_text(json.dumps(r,indent=2),encoding='utf-8')
    comparisons={}
    for rev in ['773db56','c28a18e','907a450']:
        d=json.loads(subprocess.check_output(['git','show',rev+':exports/replay/normal.json']))
        comparisons[rev]={'actual_wording_counts':categories(d),'llm_choice_hours':sum(h['agent']['source']=='llm' for h in d['hours']),
            'rule_hours_by_reason':dict(Counter(h['agent']['llm']['reason'] for h in d['hours'] if h['agent']['source']=='rule'))}
    result={'status':'passed','changed_text_fields':changes,'visible_strings_scanned':texts,'new_llm_calls':0,'new_dispatches':0,'controls_economics_and_sources_preserved':True,
        'before_export_sha256':before_hash,'after_export_sha256':{p:sha(Path(p).read_bytes()) for p in before_hash},'current_wording_categories':{n:categories(d) for n,d in current.items()},'normal_historical_comparison':comparisons,
        'limits':'historical raw timestamps retained; display_date never retimes data or asserts a new model evaluation; failed drafts not saved, per-template rejection cause unavailable'}
    Path('experiments/live_display_refresh.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','changed_text_fields':changes,'visible_strings_scanned':texts,'new_llm_calls':0,'new_dispatches':0},indent=2))


if __name__=='__main__':main()
