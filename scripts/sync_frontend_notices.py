"""Copy the authoritative frontend license section byte-for-byte; never write twin/."""
import argparse,hashlib,json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'twin/public/THIRD-PARTY-LICENSES.txt'
TARGET=ROOT/'THIRD_PARTY_NOTICES'
HEADING=b'Third-party license notices'
BEGIN=b'=== BEGIN FRONTEND LICENSES (verbatim from twin/public/THIRD-PARTY-LICENSES.txt) ===\n'
END=b'\n=== END FRONTEND LICENSES ===\n'


def source_section(source):
    data=source.read_bytes()
    # Current authority is frontend-only; copy the entire file unchanged.
    if data.startswith(b'Frontend third-party license notices'):return data
    # Compatibility with older authority that also prefixed a data notice.
    if data.count(HEADING)!=1:raise ValueError('Expected one frontend license heading')
    return data[data.index(HEADING):]


def rendered(source=SOURCE,target=TARGET):
    current=target.read_bytes();section=source_section(source)
    if BEGIN in current:
        if current.count(BEGIN)!=1 or current.count(END)!=1:raise ValueError('Ambiguous generated section')
        before,tail=current.split(BEGIN);_,after=tail.split(END)
    else:
        # First adoption: replace old manually embedded license suffix only.
        if current.count(HEADING)!=1:raise ValueError('Expected one legacy frontend suffix')
        before=current[:current.index(HEADING)];after=b''
    return before+BEGIN+section+END+after


def sync(source=SOURCE,target=TARGET,check=False):
    expected=rendered(source,target)
    if check:
        if target.read_bytes()!=expected:raise ValueError('Frontend notice drift: run python -m scripts.sync_frontend_notices')
    else:target.write_bytes(expected)
    print(json.dumps({'status':'passed','check_only':check,'frontend_section_sha256':hashlib.sha256(source_section(source)).hexdigest()}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args();sync(check=args.check)
