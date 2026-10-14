import hashlib
from pathlib import Path
import pytest
from scripts import download_bdg2_thermal as download


def test_mismatch_deleted_then_verified_redownload_without_config_or_headers(monkeypatch,tmp_path):
    monkeypatch.setattr(download,'ROOT',tmp_path);events=[]
    monkeypatch.setattr(download,'report',lambda **e:events.append(e));monkeypatch.setattr(download,'verify_pointer',lambda s:None)
    good=b'timestamp,Byron\n2017-01-01,12\n';spec={'bytes':len(good),'sha256':hashlib.sha256(good).hexdigest(),'download_url':'https://example.invalid/public.csv'}
    part=tmp_path/'test.csv.part';calls=[]
    class Code:returncode=0
    def curl(args,**kw):
        assert args[:2]==['curl.exe','-q'] and '--fail' in args and '-C' in args
        assert not any(a in args for a in ['--user','--header','-H'])
        calls.append(args);part.write_bytes(b'x'*len(good) if len(calls)==1 else good);return Code()
    monkeypatch.setattr(download.subprocess,'run',curl)
    assert download.download('test.csv',spec,slices=2)
    assert (tmp_path/'test.csv').read_bytes()==good and not part.exists()
    assert any(e['event']=='mismatch_deleted_retry' for e in events)
    assert events[-1]['event']=='verified' and len(calls)==2


def test_integrity_loader_rejects_bad_official_bytes(monkeypatch,tmp_path):
    import json
    from src.data.hvac import load_meters
    name='steam_cleaned.csv';(tmp_path/name).write_bytes(b'bad')
    lock=tmp_path/'lock.json';lock.write_text(json.dumps({'files':{name:{'sha256':'0'*64,'bytes':3,'pointer_url':'unused'}}}))
    with pytest.raises(ValueError,match='integrity'):load_meters(tmp_path,lock)
