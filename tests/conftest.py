"""Unit tests isolate process-wide admission state, never disable rate limits."""
import pytest
from src.api import rate_limit


@pytest.fixture(autouse=True)
def fresh_chat_rate_limit(monkeypatch):
    # 67e0900 introduced one global IP/LLM quota; 0cfe063 retained it with
    # Shanghai-day/Redis recovery. TestClient always uses the same client IP,
    # so unrelated tests must not consume each other's quota. Keep the real
    # default thresholds and memory implementation (no Redis/network/secrets).
    # test_rate_limit.py installs its own limiter after this parent fixture;
    # all requests WITHIN each test still accumulate and can return 429.
    monkeypatch.setattr(rate_limit, '_limiter',
                        rate_limit.RateLimiter(redis_client=None))
