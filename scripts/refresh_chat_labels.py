"""UI prose aliases only; machine IDs and source provenance stay untouched."""
import json,hashlib
from pathlib import Path
from src.agent.display_text import render_public_fields
from scripts.refresh_live_display import without_prose


def main():
    counts={}
    for n in ['normal','peak','abstain']:
        p=Path(f'exports/replay/{n}.json');d=json.loads(p.read_text(encoding='utf-8'));new=render_public_fields(d)
        assert without_prose(d)==without_prose(new)
        counts[n]=int(d!=new);p.write_text(json.dumps(new,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    hashes={n+'.json':hashlib.sha256(Path(f'exports/replay/{n}.json').read_bytes()).hexdigest() for n in counts}
    for n in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{n}.json');d=json.loads(p.read_text());d['export_sha256']=hashes;p.write_text(json.dumps(d,indent=2),encoding='utf-8')
    print(json.dumps({'changed_exports':counts,'new_llm_calls':0,'controls_preserved':True}))


if __name__=='__main__':main()
