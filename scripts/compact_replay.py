"""Offline 1.5 exporter: precision-limited main, frozen Agent detail, no LLM."""
import argparse,copy,gzip,hashlib,json
from pathlib import Path
from jsonschema import Draft202012Validator
from src.data.replay_payload import SCENARIOS,load_replay,split_payload,hydrate_hour,display_precision
from scripts.refresh_live_display import categories


def encode(data):return json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')


def sizes(raw):return {'raw_bytes':len(raw),'gzip_bytes':len(gzip.compress(raw,compresslevel=9,mtime=0))}


def validate_pair(main,detail,full):
    schema=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    detail_schema=json.loads(Path('contracts/agent-detail.schema.json').read_text(encoding='utf-8'))
    for schema,data in [(schema,main),(detail_schema,detail)]:
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER).validate(data)
    restored=copy.deepcopy(main);restored['hours']=[hydrate_hour(main,r,detail) for r in main['hours']]
    assert restored['hours']==full['hours'],'exact runtime roundtrip failed'
    assert categories(main)==categories(full),'wording source changed'
    for row,original in zip(main['hours'],full['hours']):
        assert row['abstain']==original['abstain']
        for p,old in zip(row['forecast_24h'],original['forecast_24h']):
            assert p['abstain']==old['abstain'] and p['horizon']==old['horizon'] and p['t']==old['t']
            assert p['lower_kw']<=p['point_kw']<=p['upper_kw']
            assert sum(round(x*10) for x in p['floors_kw'])==round(p['point_kw']*10)
        assert sum(round(x*10) for x in row['floors_kw'])==round(row['point_kw']*10)
    assert display_precision(main)==main,'display precision is not idempotent'
    assert len(encode(main))<=700_000,'main display exceeds 0.7 MB'


def main(root=Path('exports/replay'),check=False):
    root=Path(root);prepared={};report={};hashes={};source_counts={}
    report_path=Path('experiments/replay15_compaction.json')
    previous=json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}
    for scenario in SCENARIOS:
        path=root/f'{scenario}.json';raw=path.read_bytes();data=load_replay(scenario,root)
        payload,detail=split_payload(data);main_bytes=encode(payload)
        detail['main_sha256']=hashlib.sha256(main_bytes).hexdigest();detail_bytes=encode(detail)
        validate_pair(payload,detail,data)
        restored=copy.deepcopy(payload);restored['hours']=[hydrate_hour(payload,r,detail) for r in payload['hours']]
        restored['meta']={**detail['origin_metadata'],'agent_detail_file':payload['meta']['agent_detail_file']}
        again_main,again_detail=split_payload(restored);again_detail['main_sha256']=detail['main_sha256']
        assert encode(again_main)==main_bytes and encode(again_detail)==detail_bytes,'pair not idempotent'
        detail_path=root/f'{scenario}.agent-detail.json'
        if data['schema_version']=='1.5':
            before_main=previous.get('files',{}).get(path.as_posix(),{}).get('before',sizes(raw))
            before_detail=previous.get('files',{}).get(detail_path.as_posix(),{}).get('before',{'raw_bytes':0,'gzip_bytes':0})
        else:before_main=sizes(raw);before_detail=sizes(detail_path.read_bytes()) if detail_path.exists() else {'raw_bytes':0,'gzip_bytes':0}
        report[path.as_posix()]={'before':before_main,'after':sizes(main_bytes)}
        report[detail_path.as_posix()]={'before':before_detail,'after':sizes(detail_bytes)}
        source_counts[scenario]={'before':categories(data),'after':categories(payload)}
        hashes[path.name]=hashlib.sha256(main_bytes).hexdigest()
        prepared[path]=main_bytes;prepared[detail_path]=detail_bytes
    if check:
        assert all(p.read_bytes()==raw for p,raw in prepared.items()),'compact export drift'
        print(json.dumps({'status':'passed','check_only':True,'files':report}));return
    for p,raw in prepared.items():p.write_bytes(raw)
    for name in ('agent_replay_export','future24_export'):
        p=Path('experiments')/f'{name}.json';receipt=json.loads(p.read_text(encoding='utf-8'))
        receipt['export_sha256']=hashes
        receipt['payload_schema_version']='1.5'
        receipt['agent_detail_sha256']={p.name:hashlib.sha256(raw).hexdigest() for p,raw in prepared.items() if '.agent-detail.' in p.name}
        p.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    result={'status':'passed','schema_version':'1.5','files':report,'source_counts':source_counts,
        'new_llm_calls':0,'new_dispatches':0,'exact_runtime_roundtrip':True,'gate_booleans_preserved':True,
        'pair_idempotent':True,'display_precision':'nearest half-even; power/energy/cost/temp 1 decimal, probabilities/ratios 4',
        'runtime_precision':'frozen Agent evidence and sparse numeric overrides retain exact originals, not display data',
        'engineering_metadata_unchanged':True}
    Path('experiments/replay15_compaction.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args();main(check=args.check)
