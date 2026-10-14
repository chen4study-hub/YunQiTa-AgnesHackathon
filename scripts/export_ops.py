"""Build only independent ops files; report raw and deterministic gzip sizes."""
import argparse
import json
from src.ops.config import ROOT, SCENARIOS, canonical, digest
from src.ops.generated import generate
from src.ops.git_evidence import head_revision,committed_export,export_revision
from src.ops.calendar import document
from src.ops.serialization import validate,check_size,encode_day


def build(revision=None):
    revision=revision or head_revision()
    output={}
    for scenario in SCENARIOS:
        output.update(encode_day(generate(scenario,revision=revision)))
    raw=canonical(document(revision));validate(raw)
    output['ops-calendar.json']=raw
    report=[check_size(raw,name) for name,raw in output.items()]
    return output,report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true',help='verify existing bytes without writes')
    args=parser.parse_args()
    target=ROOT/'exports/replay'
    revision=head_revision()
    if args.check:
        saved=[json.loads((target/(s+'.ops.json')).read_bytes())['meta'] for s in SCENARIOS]
        for scenario,meta in zip(SCENARIOS,saved):
            if meta['source_sha256']!=digest(committed_export(scenario,revision)):
                raise ValueError('HEAD source exports changed; regenerate ops')
            if meta['source_git_commit']!=export_revision(scenario,revision):
                raise ValueError('source commit is not the last export-changing commit')
    output,report=build(revision)
    if not args.check and head_revision()!=revision:
        raise ValueError('HEAD changed during generation; no outputs written')
    for name,raw in output.items():
        path=target/name
        if args.check:
            if not path.exists() or path.read_bytes()!=raw:
                raise ValueError('export differs: '+name)
        else:
            path.write_bytes(raw)
    # Delete only obsolete split files owned by this generator.
    if not args.check:
        for scenario in SCENARIOS:
            name=scenario+'.ops-floors.json'
            if name not in output:
                (target/name).unlink(missing_ok=True)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
