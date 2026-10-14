"""Run one targeted v3 shard against a frozen source archive and owned test DB.

Reports/logs and snapshot must be outside the repository. No resident service is
used or stopped. Credentials are read from the existing env file, never logged.
The existing run-groups runner owns Vite/Edge cleanup and the <=8 Edge check.
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

SPECS = [
    'agent-chat-human-review.spec.ts', 'agent-chat-label-spacing.spec.ts',
    'agent-chat-markdown.spec.ts', 'agent-chat-progress-live.spec.ts',
    'agent-chat-progress.spec.ts', 'agent-chat-reasons.spec.ts',
    'agent-chat-session.spec.ts', 'agent-chat-steps.spec.ts',
    'agent-chat-stream.spec.ts', 'agent-chat-terminated.spec.ts',
    'agent-takeover-prefill.spec.ts',
]
RESIDENT = {8000, 8006, 4181, 4186, 4187, 5227}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True, type=Path)
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--shard', required=True)
    parser.add_argument('--exclude-completed', type=Path,
                        help='Explicit runner test-list of completed tests; recover only unfinished scope')
    parser.add_argument('--spec-filter', help='Comma-separated exact spec basenames for a targeted retry')
    parser.add_argument('--group', choices=('shell-time', 'overview-3d', 'forecast-agent',
                        'floors-energy', 'cross-page', 'performance'), default='forecast-agent')
    parser.add_argument('--full-group', action='store_true',
                        help='Run all specs in the selected group; default retains the 11 chat specs')
    parser.add_argument('--agent-loop', choices=('off', 'on'), default='off',
                        help='Delivery default is off: omit CHAT_AGENT_LOOP entirely')
    # The UI/specs address this display hour; wall time after 15:00 would expire
    # every one-hour test takeover before its active banner can be asserted.
    parser.add_argument('--clock', default='2026-10-13T14:00:00+08:00')
    args = parser.parse_args()
    clock = datetime.fromisoformat(args.clock)
    if clock.tzinfo is None:
        raise ValueError('Test clock must include an offset')
    repository = Path(__file__).resolve().parents[2]
    snapshot, output = args.snapshot.resolve(), args.output.resolve()
    if snapshot.is_relative_to(repository) or output.is_relative_to(repository):
        raise ValueError('Snapshot and output must be outside the repository')
    if not (snapshot / 'src/api/app.py').is_file() or not args.node.is_file():
        raise ValueError('Existing archive and Node executable required')
    part, total = map(int, args.shard.split('/'))
    if not 1 <= part <= total:
        raise ValueError('Invalid shard')
    output.mkdir(parents=True, exist_ok=True)
    # Select a vacant loopback port; an intervening bind fails startup, not takeover.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    if port in RESIDENT:
        raise RuntimeError('Selected a reserved port; no process started')
    from dotenv import load_dotenv
    load_dotenv(args.env_file.resolve(), override=False)
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    for key in ('AGENT_UI_ORIGIN', 'E2E_GROUP_TEST_LIST_INVERT', 'DATABASE_URL'):
        env.pop(key, None)
    # Explicitly remove inherited/.env values for delivery-default acceptance.
    env.pop('CHAT_AGENT_LOOP', None)
    if args.agent_loop == 'on':
        env['CHAT_AGENT_LOOP'] = '1'
    snapshot_commit = subprocess.check_output(
        ['git', 'rev-parse', 'HEAD'], cwd=snapshot, text=True).strip()
    env.update({
        'LLM_MODE': 'real',
        'AGNES_TEST_CLOCK': clock.isoformat(),
        'YUNQI_DB_PATH': str(output / 'test.sqlite3'),
        'OPS_SOURCE': 'generated', 'OPS_TIMEZONE': 'Asia/Shanghai',
        'PLAYWRIGHT_PORT': '5227', 'AGENT_PROGRESS_LIVE': '1',
        'AGNES_TEST_BACKEND': f'http://127.0.0.1:{port}',
        'E2E_GROUP_OUTPUT_ROOT': str(output), 'E2E_GROUP_SHARD': args.shard,
        'E2E_GROUP_SPEC_FILTER': args.spec_filter or ('' if args.full_group else ','.join(SPECS)),
        'E2E_GROUP_TEST_LIST_INVERT': str(args.exclude_completed.resolve()) if args.exclude_completed else '',
        'E2E_GROUP_CONFIG': 'e2e/isolated-acceptance.config.ts',
        'AGENT_LIVE_URL': 'http://127.0.0.1:5227/',
        'AGENT_TAKEOVER_LIVE': '1',
        'E2E_GROUP_GLOBAL_TIMEOUT_MS': '450000',
        # Let clone Git supply provenance; an inherited override contaminates
        # the source-archive test that deliberately verifies missing Git.
        'VITE_GIT_COMMIT': '',
        'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
        'PATH': str(args.node.parent) + os.pathsep + env.get('PATH', ''),
    })
    tag = args.shard.replace('/', '-')
    backend_log = output / f'backend-{tag}.log'
    runner_log = output / f'runner-{tag}.log'
    backend = None
    runner = None
    code = 1
    started = time.time()
    try:
        with backend_log.open('w', encoding='utf-8') as log:
            backend = subprocess.Popen(
                [sys.executable, '-c',
                 # Test-only fixture injection before any Repository is created;
                 # frozen product files and the resident databases are untouched.
                 "import os; from datetime import datetime; import src.db.repository as r; "
                 "r.utc_now=lambda: datetime.fromisoformat(os.environ['AGNES_TEST_CLOCK']); "
                 "from src.api.app import app; import uvicorn; "
                 "print('Test backend CHAT_AGENT_LOOP=' + "
                 "repr(os.environ.get('CHAT_AGENT_LOOP')),flush=True); "
                 f"uvicorn.run(app,host='127.0.0.1',port={port},access_log=False)"],
                cwd=snapshot, env=env, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT,
            )
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if backend.poll() is not None:
                    raise RuntimeError('Owned backend exited during startup; inspect backend log')
                try:
                    with urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                        health = json.load(response)
                    if health['llm']['mode'] != 'real':
                        raise RuntimeError('Live chat requires configured real provider; no keys logged')
                    break
                except OSError:
                    time.sleep(.2)
            else:
                raise RuntimeError('Owned backend did not become ready')
            print(f'Owned v3 backend pid={backend.pid} port={port}; isolated database; shard={args.shard}', flush=True)
            with runner_log.open('w', encoding='utf-8') as log:
                runner = subprocess.Popen(
                    [str(args.node), 'e2e/run-groups.mjs', args.group],
                    cwd=snapshot / 'twin', env=env, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT,
                )
                code = runner.wait(timeout=495)
    finally:
        if runner is not None and runner.poll() is None:
            # Own runner tree only; never name-based process killing.
            subprocess.run(['taskkill', '/PID', str(runner.pid), '/T', '/F'],
                           capture_output=True, timeout=20)
            runner.wait(timeout=10)
        if backend is not None and backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=10)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=10)
        audit = {'shard': args.shard, 'port': port, 'group': args.group,
                 'full_group': args.full_group,
                 'backend_pid': backend.pid if backend else None,
                 'backend_exited': backend is None or backend.poll() is not None,
                 'runner_exit': runner.returncode if runner else None,
                 'elapsed_seconds': round(time.time() - started, 2),
                 'database': env['YUNQI_DB_PATH'], 'snapshot': str(snapshot),
                 'repository_clock': clock.isoformat(),
                 'snapshot_commit': snapshot_commit,
                 'agent_loop': args.agent_loop,
                 'chat_agent_loop_present': 'CHAT_AGENT_LOOP' in env}
        (output / f'cleanup-{tag}.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
        print(json.dumps(audit), flush=True)
        if runner_log.exists():
            print('\n'.join(runner_log.read_text(encoding='utf-8', errors='replace').splitlines()[-8:]))
    return code


if __name__ == '__main__':
    # Windows console code pages cannot encode all Playwright titles/summaries.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
