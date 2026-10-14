import hashlib,json,subprocess
from pathlib import Path
import pytest
from scripts import audit_dependency_licenses as audit
from scripts.sync_frontend_notices import BEGIN


@pytest.mark.parametrize('fail',[False,True])
def test_temporary_audit_cleanup_success_and_failure(monkeypatch,tmp_path,fail):
    locations=[];commands=[]
    class Builder:
        def __init__(self,**kwargs):assert kwargs=={'with_pip':True}
        def create(self,path):locations.append(path)
    monkeypatch.setattr(audit.venv,'EnvBuilder',Builder)
    monkeypatch.setattr(audit,'package_snapshot',lambda:[('runtime','1')])
    monkeypatch.setenv('LLM_API_KEY','test-placeholder')
    def run(command,**kwargs):
        commands.append(command)
        assert str(locations[0]) in command[0] and kwargs['capture_output']
        assert 'LLM_API_KEY' not in kwargs['env']
        if fail:raise subprocess.CalledProcessError(1,command)
        if 'piplicenses' in command:assert command[command.index('--python')+1]==audit.sys.executable
    monkeypatch.setattr(audit.subprocess,'run',run)
    monkeypatch.setattr(audit.subprocess,'check_output',lambda *a,**k:'piplicenses.py 5.5.5')
    if fail:
        with pytest.raises(subprocess.CalledProcessError):audit.audit_in_temporary_venv(tmp_path)
    else:
        version,isolation=audit.audit_in_temporary_venv(tmp_path)
        assert version=='piplicenses.py 5.5.5' and isolation['global_packages_unchanged'] and isolation['temporary_venv_deleted']
        assert len(commands)==3 and 'pip-licenses==5.5.5' in commands[0]
    assert len(locations)==1 and not locations[0].exists()


def test_real_venv_audit_evidence_and_unified_conclusion():
    result=json.loads(Path('experiments/dependency_license_audit_v2.json').read_text())
    assert result['conclusion']==audit.CONCLUSION
    assert result['isolation']['temporary_venv_deleted'] and result['isolation']['global_packages_unchanged']
    assert not result['isolation']['tool_installed_globally']
    for filename,digest in result['inventory_sha256'].items():
        assert hashlib.sha256((Path('experiments')/filename).read_bytes()).hexdigest()==digest
    for name in ['THIRD_PARTY_NOTICES','experiments/closing_checks_report.md']:
        content=Path(name).read_bytes().split(BEGIN)[0].decode('utf-8')
        assert audit.CONCLUSION in content
        assert '零 GPL' not in content and '零GPL' not in content
    assert not any(result[k] for k in ['python_gpl_agpl_metadata','frontend_gpl_agpl_metadata','unknown_python','unknown_frontend'])
