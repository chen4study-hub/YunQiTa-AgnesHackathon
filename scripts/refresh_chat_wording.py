"""Offline, fixed-file prose refresh; never scan Ops or other sessions' exports."""
import hashlib,json
from pathlib import Path
from jsonschema import Draft202012Validator
from src.agent.display_text import render_public_fields
from scripts.compact_replay import encode
from scripts.refresh_live_display import categories,without_prose


def refresh(root=Path('exports/replay')):
    root=Path(root);prepared={};counts={};hashes={}
    for name in ('normal','peak','abstain'):
        main_path=root/f'{name}.json';detail_path=root/f'{name}.agent-detail.json'
        old=json.loads(main_path.read_text(encoding='utf-8'))
        detail=json.loads(detail_path.read_text(encoding='utf-8'))
        assert detail['main_sha256']==hashlib.sha256(main_path.read_bytes()).hexdigest()
        main=render_public_fields(old);new_detail=render_public_fields(detail)
        assert without_prose(main)==without_prose(old)
        assert without_prose(new_detail)==without_prose(detail)
        assert categories(main)==categories(old)
        counts[name]={'before':categories(old),'after':categories(main)}
        raw=encode(main);hashes[main_path.name]=hashlib.sha256(raw).hexdigest()
        new_detail['main_sha256']=hashes[main_path.name]
        for data,schema in ((main,'replay.schema.json'),(new_detail,'agent-detail.schema.json')):
            Draft202012Validator(json.loads(Path('contracts',schema).read_text(encoding='utf-8'))).validate(data)
        prepared[main_path]=raw;prepared[detail_path]=encode(new_detail)
    # All pairs pass invariants/schema checks before any write.
    for path,raw in prepared.items():path.write_bytes(raw)
    return {'status':'passed','new_llm_calls':0,'new_dispatches':0,
        'nonprose_unchanged':True,'source_counts':counts,'export_sha256':hashes}


def main():
    receipt=refresh()
    for name in ('agent_replay_export','future24_export'):
        path=Path('experiments',name+'.json');data=json.loads(path.read_text(encoding='utf-8'))
        data['export_sha256']=receipt['export_sha256']
        path.write_text(json.dumps(data,indent=2),encoding='utf-8')
    Path('exports/chat_wording_audit.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(receipt,ensure_ascii=False))


if __name__=='__main__':main()
