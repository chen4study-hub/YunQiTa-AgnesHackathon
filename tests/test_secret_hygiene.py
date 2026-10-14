"""Scan tracked repository content only; never print candidate secrets."""
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.run(['git',*args],cwd=ROOT,capture_output=True,check=False)


def test_environment_ignore_and_no_tracked_secret_files():
    for path in ('.env','.env.production','secrets/example.txt','private.key'):
        assert git('check-ignore','-q',path).returncode==0
    assert git('check-ignore','-q','.env.example').returncode==1
    files=git('ls-files','-z').stdout.decode('utf-8').split('\0')
    assert '.env' not in files
    assert not any((f.startswith('.env.') and f!='.env.example') or f.startswith('secrets/') or f.endswith('.key') for f in files if f)
    example=(ROOT/'.env.example').read_text(encoding='utf-8')
    # 67e0900 added safe quota defaults; 0cfe063 documented Shanghai reset and
    # Redis recovery. Comments are not secrets, but every assigned key/value is
    # still asserted exactly (including blank credentials/Redis address).
    settings=dict(line.split('=',1) for line in example.splitlines()
                  if line and not line.startswith('#'))
    assert settings==dict(LLM_MODE='demo',LLM_API_KEY='',LLM_API_KEY_FILE='',
        LLM_BASE_URL='',LLM_MODEL='',LLM_TIMEOUT_SECONDS='30',
        RATE_LIMIT_REDIS_URL='',RATE_LIMIT_IP_PER_MINUTE='10',
        RATE_LIMIT_IP_PER_DAY='200',RATE_LIMIT_LLM_PER_DAY='2000')


def test_no_long_provider_key_strings_in_tracked_repository():
    # Construct the pattern without embedding a realistic token in the test itself.
    pattern=re.compile(rb'sk'+rb'-[A-Za-z0-9_-]{21,}')
    files=git('ls-files','-z').stdout.decode('utf-8').split('\0')
    violations=[]
    for name in files:
        if not name:continue
        # Inspect indexed bytes as well as working copy, to catch stale staged secrets.
        indexed=git('show',':'+name)
        path=ROOT/name
        if pattern.search(indexed.stdout) or (path.is_file() and pattern.search(path.read_bytes())):
            violations.append(name)
    assert not violations,'Possible provider key found in tracked files: '+', '.join(violations)
