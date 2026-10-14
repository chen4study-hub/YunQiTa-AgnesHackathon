import subprocess
from scripts.check_staged_secrets import check


def test_hook_checks_staged_bytes_not_working_tree(tmp_path):
    subprocess.run(['git','init',str(tmp_path)],capture_output=True,check=True)
    f=tmp_path/'fixture.txt'
    # Construct synthetic token only in disposable test repository.
    f.write_text('sk'+'-'+'A'*24,encoding='utf-8')
    subprocess.run(['git','add','fixture.txt'],cwd=tmp_path,check=True)
    f.write_text('clean working copy',encoding='utf-8')
    assert check(tmp_path) is False
    subprocess.run(['git','add','fixture.txt'],cwd=tmp_path,check=True)
    assert check(tmp_path) is True
