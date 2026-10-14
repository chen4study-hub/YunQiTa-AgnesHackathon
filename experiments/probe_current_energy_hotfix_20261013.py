"""Three real-provider endpoint checks in one process; no resident backend touched."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.update(LLM_MODE='real', OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
os.environ.pop('DATABASE_URL', None)
with tempfile.TemporaryDirectory(prefix='agnes-energy-hotfix-') as temp:
    os.environ['YUNQI_DB_PATH'] = str(Path(temp) / 'test.db')
    from fastapi.testclient import TestClient
    from src.api.app import app
    from src.data.replay_payload import load_replay
    data = load_replay('normal')
    cases = [
        ('当前能源怎么样', 'current_energy', ['光伏', '电网', '储能', 'kW'], []),
        ('现在用电情况如何', 'energy_totals', ['kWh', '元'], []),
        ('光伏现在发多少电', 'current_energy', ['光伏', '114.3 kW'], ['kWh']),
    ]
    report = {'api_transport': 'in-process HTTP ASGI', 'llm_mode': 'real', 'completed': False,
              'resident_changed': False, 'results': []}
    path = Path('experiments/current_energy_hotfix_real_20261013.json')
    with TestClient(app) as client:
        for i, (question, tool, required, excluded) in enumerate(cases):
            started = time.monotonic()
            response = client.post('/chat/stream', json={
                'question': question, 'scenario': 'normal', 'origin': data['hours'][14]['t'],
                'display_date': '2026-10-13', 'display_time': '14:00', 'session_id': f'energy-hotfix-{i}'})
            response.raise_for_status()
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            answer = ''.join(e['text'] for e in events if e['type'] == 'answer_delta')
            done = next(e for e in reversed(events) if e['type'] == 'done')
            names = [e['tool'] for e in events if e['type'] == 'tool_start']
            valid = bool(done.get('known') and done.get('grounded') and not done.get('terminated')
                         and tool in names and 'web_search' not in names
                         and all(s in answer for s in required)
                         and not any(s in answer for s in excluded + ['公开资料', '常识整理']))
            result = {'question': question, 'answer': answer, 'done': done, 'tools': names,
                      'elapsed_ms': round((time.monotonic() - started) * 1000, 1), 'passed': valid}
            report['results'].append(result)
            path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(result, ensure_ascii=False), flush=True)
    report['completed'] = True
    report['passed'] = sum(r['passed'] for r in report['results'])
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if report['passed'] != 3:
        raise SystemExit(1)
