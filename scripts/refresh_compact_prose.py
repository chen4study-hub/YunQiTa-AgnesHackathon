"""Offline UI-prose refresh: controls, economics, provenance unchanged; no LLM."""
import json,hashlib,re
from pathlib import Path
from jsonschema import Draft202012Validator
from scripts.refresh_live_display import without_prose,categories
from src.agent.display_text import render_public_fields,PUBLIC_TEXT_FIELDS,BANNED_USER_WORDS


def remove_llm_policy_sentences(obj,llm=False,key=''):
    """Drop whole LLM policy sentences before wording substitutions; retain provenance."""
    if isinstance(obj,dict):
        source=obj.get('explanation_source',obj.get('source'))
        owned=(source=='llm') if source is not None else llm
        return {k:remove_llm_policy_sentences(v,owned,k) for k,v in obj.items()}
    if isinstance(obj,list):return [remove_llm_policy_sentences(v,llm,key) for v in obj]
    if isinstance(obj,str) and llm and key in PUBLIC_TEXT_FIELDS:
        return ''.join(s for s in re.split(r'(?<=[。！？!?\n])',obj) if not any(w in s for w in ('容差','微差'))).replace('区间上界峰值','负荷偏高时的峰值')
    return obj


def repair_known_paragraphs(data):
    """Read-through fixes for frozen paragraphs; no source or numeric claim changes."""
    if not isinstance(data,dict):return data
    scenario=data.get('meta',{}).get('scenario')
    if not isinstance(data.get('hours'),list):return data
    opening={
        ('normal',7):'按负荷上限 1,309.1 kW安排调度。19:00以 500.0 kW放电覆盖峰段；次日 00:00、02:00及05:00–06:00充电，空调保持 25.5 °C，储能电量未越界。09:00–18:00预测被拒绝，保持设定、不充放电，需值班人员复核。',
        ('peak',7):'按负荷上限 1,336.3 kW安排调度。选用兼顾峰值和电费的方案，负荷偏高时的峰值为 1,150.3 kW，调度窗口电费为 18,617.8 元。10:00–19:00安排储能放电，并保留备用电量。08:00预测被拒绝，保持设定、不充放电，需值班人员复核。',
        ('peak',21):'按负荷上限 1,351.9 kW安排调度。次日 00:00–03:00充电、18:00–19:00放电削峰，空调保持 25.5 °C。23:00及次日 10:00–17:00预测被拒绝，保持设定、不充放电，需值班人员复核。未出现舒适越界。',
    }
    for index,row in enumerate(data['hours']):
        key=(scenario,index)
        if key not in opening:continue
        a=row['agent'];metrics=a.get('selection_reason',{}).get('metrics',{}).get(a.get('selected'),{})
        cost=metrics.get('energy_cost_cny');peak=metrics.get('upper_grid_peak_kw')
        paragraph=opening[key]
        if key!=('peak',7) and cost is not None and peak is not None:
            paragraph+=f"选用电费较低的方案，负荷偏高时的峰值为 {peak:,.1f} kW，调度窗口电费为 {cost:,.1f} 元。"
        paragraph+='仅比较可自动调度的时段，拒绝时段不计费用；当前小时可正常执行。'
        # All numbers must occur in existing tool evidence before replacement.
        from src.agent.orchestrator import check_grounding
        from src.agent.display_text import display_evidence
        if not check_grounding(paragraph,display_evidence(a.get('candidates',[]),row['t'],row)):
            raise ValueError('offline paragraph not grounded')
        a['explanation']=paragraph
    return data


def main(receipt_name='compact_prose_refresh'):
    assert receipt_name in ('compact_prose_refresh','disclaimer_sentence_refresh','operator_reason_refresh','chat_operator_cleanup','replay15_prose')
    prepared={};counts={};before={};scanned=0;source_counts={}
    for p in Path('exports').rglob('*.json'):
        name=p.as_posix()
        if not p.exists():continue
        # Detail belongs to its main; never rewrite a hash-bound pair separately.
        if p.name.endswith('.agent-detail.json'):continue
        raw=p.read_bytes();old=json.loads(raw)
        companion=None
        if isinstance(old,dict) and old.get('schema_version')=='1.5' and p.stem in ('normal','peak','abstain'):
            from src.data.replay_payload import load_replay,split_payload
            from scripts.compact_replay import encode
            old=load_replay(p.stem,p.parent)
            companion=p.with_name(p.stem+'.agent-detail.json')
        new=render_public_fields(remove_llm_policy_sentences(old))
        if receipt_name=='replay15_prose':new=repair_known_paragraphs(new)
        assert without_prose(old)==without_prose(new)
        if p.stem in ('normal','peak','abstain') and isinstance(old,dict) and isinstance(old.get('hours'),list):
            source_counts[name]={'before':categories(old),'after':categories(new)}
            assert source_counts[name]['before']==source_counts[name]['after']
        if p.parent.name=='replay' and p.stem in ('normal','peak','abstain','sample'):
            schema_name='replay-1.4.schema.json' if new['schema_version']=='1.4' else 'replay.schema.json'
            Draft202012Validator(json.loads(Path('contracts',schema_name).read_text(encoding='utf-8'))).validate(new)
        changed=0
        def scan(o,prev,key=''):
            nonlocal changed,scanned
            if isinstance(o,dict):
                for k,v in o.items():scan(v,prev[k],k)
            elif isinstance(o,list):
                for v,b in zip(o,prev):scan(v,b,key)
            elif isinstance(o,str) and key in PUBLIC_TEXT_FIELDS:
                scanned+=1;changed+=o!=prev
                assert not any(w in o for w in BANNED_USER_WORDS),(name,key)
                assert '不代表。次日完整全天' not in o,(name,key)
                assert not any(re.search('负荷|功率|峰值',s) and 'kWh' in s and not re.search('电量|电耗|耗电|用电|能量',s) for s in re.split(r'[，。；！？]',o)),(name,key)
        scan(new,old);counts[name]=changed;before[name]=hashlib.sha256(raw).hexdigest()
        if changed and companion is not None:
            main,detail=split_payload(new);content=encode(main)
            detail['main_sha256']=hashlib.sha256(content).hexdigest()
            prepared[p]=content;prepared[companion]=encode(detail)
        elif changed:
            options={'separators':(',',':')} if p.parent.name=='replay' else {'indent':2}
            prepared[p]=json.dumps(new,ensure_ascii=False,**options).encode('utf-8')
    for p,raw in prepared.items():p.write_bytes(raw)
    hashes={n+'.json':hashlib.sha256(Path(f'exports/replay/{n}.json').read_bytes()).hexdigest() for n in ['normal','peak','abstain']}
    for n in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{n}.json');d=json.loads(p.read_text());d['export_sha256']=hashes;p.write_text(json.dumps(d,indent=2),encoding='utf-8')
    receipt={'status':'passed','changed_text_fields':counts,'visible_strings_scanned':scanned,'new_llm_calls':0,'new_dispatches':0,'nonprose_unchanged':True,'source_counts':source_counts,'before_sha256':before,'after_sha256':hashes}
    Path(f'experiments/{receipt_name}.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt))


if __name__=='__main__':main()
