"""Hard wall-clock budget and process-wide circuit for candidate LLM calls."""
import collections
import queue
import threading
import time

BUDGET_SECONDS=15.
SLOTS=threading.BoundedSemaphore(4)


class Circuit:
    def __init__(self,threshold=3,window=60.,cooldown=90.,clock=time.monotonic):
        self.threshold=threshold;self.window=window;self.cooldown=cooldown;self.clock=clock
        self.lock=threading.Lock();self.failures=collections.deque();self.open_until=0.;self.probe=False
    def allow(self):
        with self.lock:
            now=self.clock()
            if now<self.open_until or self.probe:return False
            if self.open_until:self.probe=True
            return True
    def record(self,success):
        with self.lock:
            now=self.clock();was_probe=self.probe;self.probe=False
            if success:self.failures.clear();self.open_until=0.;return
            while self.failures and self.failures[0]<now-self.window:self.failures.popleft()
            self.failures.append(now)
            if was_probe or len(self.failures)>=self.threshold:self.open_until=now+self.cooldown


CIRCUIT=Circuit()


def bounded_choice(provider,fn,fallback):
    now=time.monotonic()
    if not hasattr(provider,'_choice_deadline'):provider._choice_deadline=now+BUDGET_SECONDS
    left=provider._choice_deadline-now
    def rule(reason):return {**fallback,'llm':{'mode':'rule','reason':'call_failed','fallback_reason':reason}}
    if left<=0:return rule('choice_deadline')
    if not SLOTS.acquire(blocking=False):return rule('choice_busy')
    if not CIRCUIT.allow():SLOTS.release();return rule('choice_circuit_open')
    box=queue.Queue(1);stop=threading.Event()
    def work():
        try:
            result=fn(left,stop)
            if not stop.is_set():box.put(result)
        except Exception:box.put(rule('call_failed'))
        finally:SLOTS.release()
    threading.Thread(target=work,daemon=True).start()
    try:
        result=box.get(timeout=max(.001,provider._choice_deadline-time.monotonic()))
        CIRCUIT.record(result['llm'].get('reason')=='call_succeeded')
        # Transport failure cannot get another budget on an orchestrator rewrite.
        if result['llm'].get('reason')!='call_succeeded':provider._choice_deadline=time.monotonic()
        return result
    except queue.Empty:
        stop.set();provider._choice_deadline=time.monotonic();CIRCUIT.record(False)
        client=getattr(provider,'_choice_client',None)
        if client is not None:
            # Socket shutdown must not delay the caller's hard deadline.
            def close():
                try:client.close()
                except Exception:pass
            threading.Thread(target=close,daemon=True).start()
        return rule('choice_deadline')
