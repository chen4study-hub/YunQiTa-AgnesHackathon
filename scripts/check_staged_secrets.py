"""Pre-commit scan of indexed blobs only. Never print matched token or content."""
import re
import subprocess
import sys

PATTERN=re.compile(rb'sk'+rb'-[A-Za-z0-9_-]{21,}')


def check(cwd=None):
    names=subprocess.run(['git','diff','--cached','--name-only','--diff-filter=ACMR','-z'],
        cwd=cwd,capture_output=True,check=True).stdout.split(b'\0')
    for raw in names:
        if not raw:continue
        name=raw.decode('utf-8')
        blob=subprocess.run(['git','show',':'+name],cwd=cwd,capture_output=True,check=True).stdout
        if PATTERN.search(blob):
            return False
    return True


if __name__=='__main__':
    try:
        safe=check()
    except Exception:
        print('Pre-commit secret scan failed; commit blocked.',file=sys.stderr)
        sys.exit(1)
    if not safe:
        print('Pre-commit blocked: possible long provider token in staged content.',file=sys.stderr)
        sys.exit(1)
