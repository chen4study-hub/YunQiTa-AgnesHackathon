import hashlib,json,os,subprocess,sys
from pathlib import Path
from scripts.check_offline_demo import clean_environment


def test_credential_environment_removed(monkeypatch):
    for key in ['LLM_API_KEY','LLM_API_KEY_FILE','AGNES_BACKEND_HOST','OPENAI_API_KEY','ANTHROPIC_API_KEY','HTTP_PROXY','BUILDING_DATA_CSV']:
        monkeypatch.setenv(key,'test-only-not-a-real-credential')
    clean=clean_environment()
    assert clean['LLM_MODE']=='demo' and clean['PYTHON_DOTENV_DISABLED']=='1'
    assert not any(k in clean for k in ['LLM_API_KEY','LLM_API_KEY_FILE','OPENAI_API_KEY','ANTHROPIC_API_KEY','HTTP_PROXY','BUILDING_DATA_CSV'])


def test_isolated_http_and_sse_offline(tmp_path):
    out=tmp_path/'check.json'
    subprocess.run([sys.executable,'-m','scripts.check_offline_demo','--output',str(out)],check=True,timeout=60,capture_output=True)
    r=json.loads(out.read_text(encoding='utf-8'))
    assert r['status']=='passed' and r['external_attempts']==0 and r['dotenv_absent'] and r['credentials_absent'] and r['managed_backend_stopped']
    assert [q['path'] for q in r['requests']]==['/health','/replay','/replay/peak','/schedule','/chat','/chat/stream']
    assert all(q.get('llm_mode',q.get('runtime_llm_mode')) in ('demo','mock') for q in r['requests'])


def test_saved_license_evidence_and_caveats():
    summary=json.loads(Path('experiments/dependency_license_audit.json').read_text())
    assert not summary['blanket_no_gpl_confirmed']
    for k in ['python_gpl_agpl_metadata','frontend_gpl_agpl_metadata','unknown_python','unknown_frontend']:assert summary[k]==[]
    for filename,digest in summary['inventory_sha256'].items():assert hashlib.sha256((Path('experiments')/filename).read_bytes()).hexdigest()==digest
    notices=Path('THIRD_PARTY_NOTICES').read_text(encoding='utf-8')
    assert 'GPL-3.0-or-later WITH GCC-exception-3.1' in notices
    assert 'FTL OR GPL-2.0-or-later' in notices
    assert summary['python_packages']==54 and summary['frontend_lock_entries']==121
