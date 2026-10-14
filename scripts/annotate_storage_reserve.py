"""Text-only annotation: no model/control/LLM rerun, only existing future refusal evidence."""
import hashlib,json
from pathlib import Path
from jsonschema import Draft202012Validator

TEXT='后续时段预测被拒绝，保留电量等值班人员复核后使用。'


def main():
    path=Path('exports/replay/abstain.json');data=json.loads(path.read_text(encoding='utf-8'));changed=0
    for row in data['hours']:
        if not any(p['abstain'] for p in row['forecast_24h'][:23]):continue
        a=row['agent']
        if TEXT not in a['explanation']:a['explanation']+=TEXT;changed+=1
        for r in [a['selection_reason']]+[c['selection_reason'] for c in a['candidates']]:
            if TEXT not in r['summary']:r['summary']+=TEXT
    schema=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator(schema).validate(data)
    path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf-8')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{name}.json');receipt=json.loads(p.read_text())
        receipt['export_sha256']['abstain.json']=digest
        p.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    print(json.dumps(dict(status='passed',text_only=True,annotated_hours=changed,llm_calls=0,controls_changed=False)))


if __name__=='__main__':main()
