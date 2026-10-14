"""Limited real v2 guard checks, one Python process and one owned-port server."""
import json
import os
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path


def main():
    os.environ.update(LLM_MODE='real', OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
    os.environ.pop('DATABASE_URL', None)
    import httpx
    import uvicorn
    cases = [
        ('/chat/stream', '特朗普的政策立场是什么？', 'politics', 'politics', ''),
        ('/chat', '现在几点', 'politics', 'terminated', ''),
        ('/chat', '今天有哪些社会新闻？', 'affairs', 'current_affairs', ''),
        ('/chat/stream', '天气怎么样', 'affairs', 'terminated', ''),
        ('/chat/stream', '今天的天气新闻有哪些？', 'weather-news', 'none', ''),
        ('/chat', '诺贝尔奖是什么？', 'nobel', 'none', ''),
        ('/chat/stream', '现在几点', 'time', 'none', '14:00'),
        ('/chat', '天气怎么样', 'weather', 'none', '°C'),
        ('/chat/stream', '当前能源怎么样', 'energy', 'none', 'kW'),
    ]
    # Pin to the committed owner interface during shared-workspace validation;
    # never edit the owner's possibly dirty file or run it as newly shipped code.
    import subprocess
    from src.agent import topic_guard
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD:src/agent/topic_guard.py'], text=True).strip()
    source = subprocess.check_output(['git', 'cat-file', 'blob', revision]).decode('utf-8')
    exec(compile(source, 'committed-topic-guard', 'exec'), topic_guard.__dict__)
    output = Path('experiments/topic_guard_v2_real_20261013.json')
    rows = []
    prefix = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='agnes-topic-v2-') as temp:
        os.environ['YUNQI_DB_PATH'] = str(Path(temp) / 'isolated.db')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config('src.api.app:app', host='127.0.0.1', port=port,
                                             log_config='configs/backend_logging.json'))
        worker = threading.Thread(target=server.run, name='owned-topic-server')
        worker.start()
        base = f'http://127.0.0.1:{port}'
        receipt = dict(results=rows, owned_port=port, completed=False, owned_server_stopped=False, resident_changed=False, topic_guard_blob=revision)
        def save():
            output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        try:
            with httpx.Client(timeout=40, trust_env=False) as client:
                for _ in range(150):
                    if server.started:
                        break
                    if not worker.is_alive():
                        raise RuntimeError('owned backend startup failed')
                    time.sleep(.1)
                else:
                    raise RuntimeError('owned backend not ready')
                assert client.get(base+'/health').json()['llm']['mode'] == 'real'
                for endpoint, question, session, expected, contains in cases:
                    sid = prefix + '-' + session
                    body = dict(question=question, scenario='normal', origin='2017-10-23T14:00:00-05:00',
                                display_date='2026-10-13', display_time='14:00', session_id=sid)
                    started = time.monotonic()
                    response = client.post(base+endpoint, json=body)
                    response.raise_for_status()
                    events = []
                    if endpoint == '/chat':
                        done = response.json()
                        answer = done['answer']
                    else:
                        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                        done = next(e for e in reversed(events) if e['type'] == 'done')
                        answer = ''.join(e['text'] for e in events if e['type'] == 'answer_delta')
                    passed = done.get('session_id') == sid and done.get('category') == expected
                    if expected == 'none':
                        passed = passed and not done.get('terminated') and done.get('known') and bool(answer)
                    else:
                        from src.agent.topic_guard import refusal_message
                        passed = passed and done.get('terminated') and done.get('answer') == answer == refusal_message()
                    if contains:
                        passed = passed and contains in answer
                    row = dict(endpoint=endpoint, question=question, session_id=sid, expected=expected,
                               passed=bool(passed), answer=answer, done=done,
                               elapsed_ms=round((time.monotonic()-started)*1000, 1),
                               event_types=[e['type'] for e in events])
                    rows.append(row)
                    save()
                    print('RESULT', len(rows), row['passed'], done.get('category'), question, flush=True)
        finally:
            server.should_exit = True
            worker.join(timeout=15)
            receipt.update(questions=len(rows), passed=sum(r['passed'] for r in rows),
                           completed=len(rows)==len(cases), owned_server_stopped=not worker.is_alive())
            save()
            if worker.is_alive():
                raise RuntimeError('owned server failed to stop')
    print('FINAL', json.dumps({k:v for k,v in receipt.items() if k!='results'}), flush=True)
    if receipt['passed'] != len(cases):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
