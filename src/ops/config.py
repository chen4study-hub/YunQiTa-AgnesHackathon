"""Configuration and canonical byte encoding; no process-global random state."""
import hashlib
import json
import os
from pathlib import Path
from decimal import Decimal, ROUND_HALF_EVEN

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = ('normal', 'peak', 'abstain')
DAY_MS = 86_400_000
HOUR_MS = 3_600_000
LIFT_IDS = ('L1', 'L2', 'L3', 'H1', 'H2', 'H3')
ZONES = ('north', 'northeast', 'west', 'east', 'southwest', 'south')
FLOOR_HEIGHT_M = 3.8
MAX_SPEED_M_S = 3.0
ACCELERATION_M_S2 = 1.0
RAW_LIMIT = 800_000
GZIP_LIMIT = 150_000


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def decimal1(value):
    result = float(Decimal(str(value)).quantize(Decimal('.1'), rounding=ROUND_HALF_EVEN))
    return 0.0 if result == 0 else result


def keyed(source_date, entity, event):
    raw = f'{source_date}|{entity}|{event}'.encode('utf-8')
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], 'big') / 2**64


def allocate(total, weights):
    """Largest remainder in 0.1 units, stable index tie breaking."""
    from math import floor
    units = int(Decimal(str(total)) * 10)
    if units < 0 or any(w < 0 for w in weights):
        raise ValueError('negative allocation')
    denom = sum(weights)
    if not denom:
        weights = [1] * len(weights)
        denom = len(weights)
    exact = [units * w / denom for w in weights]
    base = [floor(v) for v in exact]
    order = sorted(range(len(base)), key=lambda i: (-(exact[i] - base[i]), i))
    for i in order[:units - sum(base)]:
        base[i] += 1
    return [v / 10 for v in base]


def settings():
    zone = os.getenv('OPS_TIMEZONE', 'Asia/Shanghai')
    # 24 hourly static rows require a fixed-offset display day.
    if zone not in ('Asia/Shanghai', 'UTC'):
        raise ValueError('OPS_TIMEZONE must be Asia/Shanghai or UTC')
    return {'source': os.getenv('OPS_SOURCE', 'generated'), 'timezone': zone,
            'live_factory': os.getenv('OPS_LIVE_FACTORY', '')}


def tariff():
    source = json.loads((ROOT / 'configs/agent_tools.json').read_text(encoding='utf-8'))['tariff']
    periods = ['valley' if h in source['valley_hours'] else
               'peak' if h in source['peak_hours'] else 'flat' for h in range(24)]
    return {'currency': source['currency'], 'unit': 'CNY/kWh',
            'definition': 'configs/agent_tools.json:tariff',
            'periods': periods, 'prices': [source[p] for p in periods]}
