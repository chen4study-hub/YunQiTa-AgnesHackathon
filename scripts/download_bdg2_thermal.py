"""Anonymous official-LFS download, bounded resumable slices; mismatches removed."""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime,timezone
from pathlib import Path
import urllib.request
import re
from concurrent.futures import ThreadPoolExecutor,as_completed

MANIFEST=Path('experiments/bdg2_thermal_sources.json')
ROOT=Path('data/raw/bdg2');LOG=Path('logs/download_bdg2_thermal.jsonl')


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()


def report(**event):
    LOG.parent.mkdir(exist_ok=True)
    line=json.dumps(dict(utc=datetime.now(timezone.utc).isoformat(),**event))
    with LOG.open('a',encoding='utf-8') as f:f.write(line+'\n')
    print(line,flush=True)


def verify_pointer(spec):
    # Explicit anonymous request; no env key/config/LLM/logging headers.
    with urllib.request.urlopen(spec['pointer_url'],timeout=30) as r:text=r.read(4096).decode('ascii')
    if f"oid sha256:{spec['sha256']}" not in text or f"size {spec['bytes']}" not in text:raise ValueError('Official pointer differs from lock; manual review needed')


def download(name,spec,slices=10,seconds=60):
    ROOT.mkdir(parents=True,exist_ok=True);final=ROOT/name;part=ROOT/(name+'.part')
    verify_pointer(spec);report(file=name,event='official_pointer_verified',expected_sha256=spec['sha256'],expected_bytes=spec['bytes'])
    if final.exists():
        if final.stat().st_size==spec['bytes'] and sha(final)==spec['sha256']:
            report(file=name,event='already_verified',bytes=spec['bytes'],sha256=spec['sha256']);return True
        final.unlink();report(file=name,event='invalid_final_deleted')
    for attempt in range(slices):
        before=part.stat().st_size if part.exists() else 0
        # -q ignores user curl config; explicit anonymous public GET, bounded timeout.
        code=subprocess.run(['curl.exe','-q','--fail','-L','-C','-','--connect-timeout','15','--max-time',str(seconds),'-sS','-o',str(part),spec['download_url']],capture_output=True).returncode
        size=part.stat().st_size if part.exists() else 0
        report(file=name,event='slice',attempt=attempt+1,bytes=size,delta=size-before,curl_exit=code)
        if size>=spec['bytes']:
            digest=sha(part)
            if size!=spec['bytes'] or digest!=spec['sha256']:
                part.unlink();report(file=name,event='mismatch_deleted_retry',actual_sha256=digest,bytes=size);continue
            part.replace(final);report(file=name,event='verified',bytes=size,sha256=digest);return True
        if code==33:
            part.unlink(missing_ok=True);report(file=name,event='range_unsupported_restart')
    report(file=name,event='incomplete_partial_retained');return False


def parallel_download(name,spec,workers=12,seconds=100):
    ROOT.mkdir(parents=True,exist_ok=True);final=ROOT/name;chunks=ROOT/(name+'.chunks')
    verify_pointer(spec);report(file=name,event='official_pointer_verified',expected_sha256=spec['sha256'],expected_bytes=spec['bytes'])
    if final.exists():
        if final.stat().st_size==spec['bytes'] and sha(final)==spec['sha256']:
            report(file=name,event='already_verified',bytes=spec['bytes'],sha256=spec['sha256']);return True
        final.unlink();report(file=name,event='invalid_final_deleted')
    chunks.mkdir(exist_ok=True);block=4*1024*1024
    ranges=[(i,start,min(start+block,spec['bytes'])-1) for i,start in enumerate(range(0,spec['bytes'],block))]
    def fetch(item):
        i,start,end=item;path=chunks/str(i);header=chunks/(str(i)+'.headers')
        def valid():
            if not path.exists() or path.stat().st_size!=end-start+1 or not header.exists():return False
            return bool(re.search(r'content-range:\s*bytes '+str(start)+'-'+str(end)+'/'+str(spec['bytes']),header.read_text(errors='replace'),re.I))
        if valid():return True
        for attempt in range(3):
            code=subprocess.run(['curl.exe','-q','--fail','-L','--range',f'{start}-{end}','--connect-timeout','15','--max-time',str(seconds),'-sS','-D',str(header),'-o',str(path),spec['download_url']],capture_output=True).returncode
            ok=code==0 and valid();report(file=name,event='range',chunk=i,start=start,end=end,curl_exit=code,valid_range=ok,attempt=attempt+1)
            if ok:return True
        return False
    with ThreadPoolExecutor(max_workers=workers) as pool:ok=all(list(pool.map(fetch,ranges)))
    if not ok:report(file=name,event='incomplete_chunks_retained');return False
    combined=ROOT/(name+'.assembled')
    with combined.open('wb') as out:
        for i,_,_ in ranges:
            with (chunks/str(i)).open('rb') as f:
                for data in iter(lambda:f.read(1024*1024),b''):out.write(data)
    digest=sha(combined)
    import shutil
    if digest!=spec['sha256']:
        combined.unlink();shutil.rmtree(chunks);report(file=name,event='mismatch_deleted_retry_required',actual_sha256=digest);return False
    combined.replace(final);shutil.rmtree(chunks);(ROOT/(name+'.part')).unlink(missing_ok=True)
    report(file=name,event='verified',bytes=final.stat().st_size,sha256=digest);return True


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--slices',type=int,default=5);parser.add_argument('--seconds',type=int,default=45)
    parser.add_argument('--workers',type=int,default=0)
    args=parser.parse_args();manifest=json.loads(MANIFEST.read_text())
    if args.workers:
        results=[]
        for name,spec in manifest['files'].items():
            ok=parallel_download(name,spec,args.workers,args.seconds)
            if not ok:ok=parallel_download(name,spec,args.workers,args.seconds)
            results.append(ok)
    else:results=[download(name,spec,args.slices,args.seconds) for name,spec in manifest['files'].items()]
    raise SystemExit(0 if all(results) else 2)


if __name__=='__main__':main()
