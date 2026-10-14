"""Atomic Asia/Shanghai day limits with bounded Redis recovery attempts."""
import hashlib
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass
from fastapi import HTTPException, Request

LOG = logging.getLogger(__name__)
# Asia/Shanghai uses UTC+08:00 for the service's contemporary dates.
DAY_OFFSET = 8 * 3600
RECONNECT_SECONDS = 60
# Separate the new day buckets from previously deployed UTC-window counters.
REDIS_PREFIX = 'rate-limit:v2:'


def window_offset(seconds):
    return DAY_OFFSET if seconds == 86400 else 0


def window_end(key):
    return (key[2]+1)*key[1] - window_offset(key[1])

# One script checks all windows and then increments them as one transaction.
# Redis TIME, not worker clocks, defines shared minute/day boundaries.
SCRIPT = """
local now = tonumber(redis.call('TIME')[1])
local reserve = tonumber(ARGV[1])
local keys, counts, ttls = {}, {}, {}
local wait = 0
for i = 2, #ARGV, 3 do
    local name, seconds, limit = ARGV[i], tonumber(ARGV[i+1]), tonumber(ARGV[i+2])
    local offset = seconds == 86400 and 28800 or 0
    local bucket = math.floor((now + offset) / seconds)
    local key = KEYS[1] .. name .. ':' .. bucket
    local count = tonumber(redis.call('GET', key) or '0')
    local ttl = (bucket + 1) * seconds - offset - now
    table.insert(keys, key); table.insert(counts, count); table.insert(ttls, ttl)
    if count >= limit then wait = math.max(wait, ttl) end
end
if wait == 0 and reserve == 1 then
    for i, key in ipairs(keys) do
        counts[i] = redis.call('INCR', key)
        redis.call('EXPIRE', key, ttls[i])
    end
end
local result = {wait, now}
for _, count in ipairs(counts) do table.insert(result, count) end
return result
"""


# Merge only accepted fallback increments, never the mirrored shared totals.
# Expired windows are skipped according to Redis TIME. Atomic INCRBY preserves
# other workers' usage before this worker resumes shared admission.
RECOVER_SCRIPT = """
local now = tonumber(redis.call('TIME')[1])
local marker = KEYS[1] .. 'recovery:' .. ARGV[1]
if redis.call('EXISTS', marker) == 1 then return 1 end
local last_expiry = now + 60
for i = 2, #ARGV, 3 do
    local key, count, expires = ARGV[i], tonumber(ARGV[i+1]), tonumber(ARGV[i+2])
    if expires > now then
        redis.call('INCRBY', KEYS[1] .. key, count)
        redis.call('EXPIRE', KEYS[1] .. key, expires - now)
        last_expiry = math.max(last_expiry, expires)
    end
end
redis.call('SET', marker, '1', 'EX', last_expiry - now)
return 1
"""


def env_limit(name, default, minimum=1):
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


@dataclass(frozen=True)
class Limits:
    ip_minute: int = 10
    ip_day: int = 200
    llm_day: int = 2000

    @classmethod
    def from_env(cls):
        return cls(env_limit('RATE_LIMIT_IP_PER_MINUTE', 10),
                   env_limit('RATE_LIMIT_IP_PER_DAY', 200),
                   env_limit('RATE_LIMIT_LLM_PER_DAY', 2000, minimum=0))


class MemoryCounters:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.lock = threading.Lock()
        self.counts = {}
        self.pending = {}
        self.cleaned_at = 0

    def _prune(self, now):
        if now - self.cleaned_at >= 60:
            self.counts = {k: v for k, v in self.counts.items() if window_end(k) > now}
            self.pending = {k: v for k, v in self.pending.items() if window_end(k) > now}
            self.cleaned_at = now

    def apply(self, specs, reserve=True):
        with self.lock:
            now = int(self.clock())
            self._prune(now)
            keys = [(name, seconds, (now+window_offset(seconds))//seconds) for name, seconds, _ in specs]
            counts = [self.counts.get(key, 0) for key in keys]
            wait = max((window_end(key)-now for key, count, spec in zip(keys, counts, specs)
                        if count >= spec[2]), default=0)
            if not wait and reserve:
                counts = [count+1 for count in counts]
                self.counts.update(zip(keys, counts))
                for key in keys:
                    self.pending[key] = self.pending.get(key, 0)+1
            return [wait, now, *counts]

    def observe(self, specs, result):
        # Preserve the observed shared usage before a Redis-to-memory switch.
        with self.lock:
            now = int(result[1])
            self._prune(now)
            for (name, seconds, _), count in zip(specs, result[2:]):
                key = (name, seconds, (now+window_offset(seconds))//seconds)
                self.counts[key] = max(self.counts.get(key, 0), int(count))


    def detach_pending(self):
        with self.lock:
            self._prune(int(self.clock()))
            args = []
            for key, count in self.pending.items():
                args.extend((f'{key[0]}:{key[2]}', count, window_end(key)))
            self.pending.clear()
            return args


_AUTO = object()


class RateLimiter:
    def __init__(self, limits=None, redis_url=None, redis_client=_AUTO, clock=time.time,
                 retry_clock=time.monotonic):
        self.limits = limits or Limits.from_env()
        self.redis_url = (os.getenv('RATE_LIMIT_REDIS_URL', '') if redis_url is None else redis_url).strip()
        self.redis = redis_client
        self.memory = MemoryCounters(clock)
        # Serialize this worker's failover/recovery and counter updates. Other
        # workers remain independently concurrent through atomic Redis scripts.
        self.lock = threading.Lock()
        self.retry_clock = retry_clock
        self.failed = False
        self.warned = False
        self.next_retry = 0
        self.recovery_batch = None

    def _fail(self):
        self.failed = True
        self.next_retry = self.retry_clock() + RECONNECT_SECONDS
        if not self.warned:
            self.warned = True
            LOG.warning('Redis rate limiter unavailable; using process-local memory limits; retry in about 60 seconds')

    def _client(self):
        if self.failed and self.retry_clock() < self.next_retry:
            return None
        if self.redis is _AUTO:
            if not self.redis_url:
                self.redis = None
            else:
                from redis import Redis
                self.redis = Redis.from_url(self.redis_url, socket_connect_timeout=.2,
                                            socket_timeout=.2, retry_on_timeout=False)
        return self.redis

    def _recover(self, client):
        # Keep the same batch ID after an ambiguous network failure: Redis may
        # have applied it before disconnecting. The script deduplicates retries.
        while True:
            if self.recovery_batch is None:
                args = self.memory.detach_pending()
                if not args:
                    return
                self.recovery_batch = [uuid.uuid4().hex, *args]
            result = client.eval(RECOVER_SCRIPT, 1, REDIS_PREFIX, *self.recovery_batch)
            if int(result) != 1:
                raise ValueError('invalid recovery result')
            self.recovery_batch = None

    def _apply(self, specs, reserve=True):
        with self.lock:
            try:
                client = self._client()
                if client is not None:
                    if self.failed:
                        self._recover(client)
                    args = [int(reserve)]
                    for spec in specs:
                        args.extend(spec)
                    result = client.eval(SCRIPT, 1, REDIS_PREFIX, *args)
                    if len(result) != len(specs)+2:
                        raise ValueError('invalid counter result')
                    result = [int(x) for x in result]
                    self.memory.observe(specs, result)
                    self.failed = False
                    return result[0]
            except Exception:
                # No URLs, credentials or exception bodies; warn once for the
                # process lifetime, but schedule bounded automatic recovery.
                self._fail()
            return self.memory.apply(specs, reserve)[0]

    def check_ip(self, ip):
        token = hashlib.sha256(ip.encode('utf-8')).hexdigest()
        return self._apply([(f'ip:{token}:minute', 60, self.limits.ip_minute),
                            (f'ip:{token}:day', 86400, self.limits.ip_day)])

    def take_llm(self):
        return not self._apply([('llm:day', 86400, self.limits.llm_day)])


_limiter = None
_init_lock = threading.Lock()


def limiter():
    global _limiter
    with _init_lock:
        if _limiter is None:
            _limiter = RateLimiter()
        return _limiter


def check_chat_rate_limit(request: Request):
    # Uvicorn's trusted proxy configuration owns this value. Never parse headers.
    ip = request.client.host if request.client is not None else 'unknown'
    wait = limiter().check_ip(ip)
    if wait:
        raise HTTPException(429, detail={'message': f'提问过于频繁，请等待 {wait} 秒后再试。',
                                        'wait_seconds': wait}, headers={'Retry-After': str(wait)})


def admit_chat_provider(factory, status_factory):
    """One reservation per admitted question, before JSON/SSE pipeline starts."""
    status = status_factory()
    if status['mode'] == 'real' and not limiter().take_llm():
        status = {'mode': 'rule', 'reason': 'daily_llm_budget_exhausted'}
    provider = factory()
    provider._rate_limit_llm_status = dict(status)
    return provider


def chat_llm_status(provider, status_factory):
    """Read the immutable entry decision, never a counter or thread-local value.

    The provider carries it across classifier/pool/native worker threads. Other
    non-chat callers retain their existing status behavior and consume no quota.
    """
    status = getattr(provider, '_rate_limit_llm_status', None)
    return dict(status) if status is not None else status_factory()
