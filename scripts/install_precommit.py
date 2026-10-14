"""Install local Git hook; refuse to overwrite any existing hook."""
from pathlib import Path
import subprocess
import sys


def main():
    path=Path(subprocess.check_output(['git','rev-parse','--git-path','hooks/pre-commit'],text=True).strip())
    if path.exists():raise FileExistsError('Existing pre-commit hook must be preserved; review manually')
    path.parent.mkdir(parents=True,exist_ok=True)
    hook='#!/bin/sh\nexec "'+sys.executable.replace('\\','/')+'" scripts/check_staged_secrets.py\n'
    path.write_text(hook,encoding='utf-8',newline='\n')
    path.chmod(path.stat().st_mode|0o111)
    print('Local pre-commit secret scan installed.')


if __name__=='__main__':main()
