"""Display-hour identity, always Asia/Shanghai."""
from datetime import datetime
from zoneinfo import ZoneInfo
from src.ops.calendar import parse_date

ZONE = ZoneInfo('Asia/Shanghai')
HOUR_MS = 3_600_000


def hour_ms(date_text, hour):
    day = parse_date(date_text)
    if isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 23:
        raise ValueError('hour must be between 0 and 23')
    return int(datetime(day.year, day.month, day.day, hour, tzinfo=ZONE).timestamp() * 1000)


def local_iso(ms):
    return datetime.fromtimestamp(ms / 1000, ZONE).isoformat()


def day_bounds(date_text):
    start = hour_ms(date_text, 0)
    return start, start + 24 * HOUR_MS
