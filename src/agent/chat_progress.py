"""One response-level heartbeat across guard, model and blocking tool stages."""
import queue
import threading
import time


def progress_events(factory, provider):
    box = queue.Queue()
    stop = threading.Event()
    start = time.monotonic()
    def work():
        pipeline = None
        try:
            pipeline = factory()
            while not stop.is_set():
                try:
                    event = next(pipeline)
                except StopIteration as end:
                    box.put(('result', end.value))
                    return
                # This clock owns progress; discard inner model-only heartbeats.
                if event.get('type') != 'progress':
                    box.put(('event', event))
        except BaseException as exc:
            box.put(('error', exc))
        finally:
            if pipeline is not None:
                pipeline.close()
    worker = threading.Thread(target=work, daemon=True, name='chat-response-progress')
    worker.start()
    elapsed, first_answer = 0, False
    try:
        while True:
            timeout = max(.001, start + elapsed + 1 - time.monotonic()) if not first_answer else .1
            try:
                kind, value = box.get(timeout=min(timeout, .1))
            except queue.Empty:
                kind, value = None, None
            # Catch up before first answer even if an event arrives exactly on a tick.
            now_elapsed = int(time.monotonic() - start)
            while not first_answer and elapsed < now_elapsed:
                elapsed += 1
                yield {'type': 'progress', 'id': 'chat-answer-wait',
                       'text': f'已等待 {elapsed} 秒', 'elapsed_seconds': elapsed}
            if kind == 'error':
                raise value
            if kind == 'result':
                return value
            if kind == 'event':
                if value.get('type') == 'answer_delta' and value.get('text'):
                    first_answer = True
                yield value
    finally:
        stop.set()
        if worker.is_alive() and hasattr(provider, 'cancel_chat'):
            provider.cancel_chat()
        worker.join(timeout=.5)
