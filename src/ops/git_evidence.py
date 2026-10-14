"""Read committed source evidence without changing Git or the working tree."""
import re
import subprocess
from functools import lru_cache
from .config import ROOT, SCENARIOS


def head_revision():
    revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode('ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{40,64}',revision):
        raise ValueError('invalid HEAD revision')
    return revision


@lru_cache(maxsize=24)
def committed_export(scenario, revision):
    if scenario not in SCENARIOS or not re.fullmatch(r'[0-9a-f]{40,64}',revision):
        raise ValueError('invalid committed source')
    return subprocess.check_output(['git','show',f'{revision}:exports/replay/{scenario}.json'],cwd=ROOT)


@lru_cache(maxsize=24)
def export_revision(scenario, revision):
    """Last path-changing commit reachable from the pinned read revision."""
    if scenario not in SCENARIOS or not re.fullmatch(r'[0-9a-f]{40,64}',revision):
        raise ValueError('invalid committed source')
    result = subprocess.check_output(['git','log','-1','--format=%H',revision,'--',
                                     f'exports/replay/{scenario}.json'],cwd=ROOT).decode('ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{40,64}',result):
        raise ValueError('source export has no committed history')
    return result
