"""Date binding and cross-midnight reads; never generate data on request."""
import copy
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from .calendar import parse_date
from .config import DAY_MS, HOUR_MS, settings
from .types import OpsDayKey
from .source import SourceUnavailable, read_calendar
from .elevators import state_at


def calendar_entry(day, calendar):
    text = day.isoformat()
    entry = next((row for row in calendar['days'] if row['date'] == text), None)
    if entry is None:
        raise LookupError('date is outside calendar coverage')
    return entry


def load_day(source, entry, building_id, timezone, floors=False):
    key = OpsDayKey(entry['scenario'], parse_date(entry['source_date']), building_id)
    try:
        data = source.read_day(key)
    except Exception as exc:
        raise SourceUnavailable('source day is unavailable') from exc
    meta = data['meta']
    if meta['building_id'] != building_id or meta['source_date'] != entry['source_date'] or meta['scenario'] != entry['scenario']:
        raise SourceUnavailable('source identity mismatch')
    if meta['timezone'] != timezone:
        raise SourceUnavailable('source timezone mismatch')
    if settings()['source'] == 'live' and meta['provider'] != 'live':
        raise SourceUnavailable('live source returned a non-live payload')
    data = copy.deepcopy(data)
    data['day_start_ms'] = entry['day_start_ms']
    if floors and 'floors_file' in meta:
        try:
            part = source.read_floors(key, meta)
        except Exception as exc:
            raise SourceUnavailable('source floors are unavailable') from exc
        for rows, extra in ((data['hours'], part['hours']), (data['history']['hours'], part['history'])):
            by_offset = {r['offset_ms']: r['floors'] for r in extra}
            for row in rows:
                row['floors'] = copy.deepcopy(by_offset[row['offset_ms']])
    return data


def day(source, date_text, building_id):
    calendar = read_calendar()
    entry = calendar_entry(parse_date(date_text), calendar)
    return load_day(source, entry, building_id, calendar['timezone'])


class FloorsInline(Exception):
    """This day already carries floors, so no separate resource exists."""


def floors(source, date_text, building_id):
    data = day(source, date_text, building_id)
    meta = data['meta']
    if 'floors_file' not in meta:
        raise FloorsInline('floors are already included in /ops/day')
    key = OpsDayKey(meta['scenario'], parse_date(meta['source_date']), building_id)
    try:
        return source.read_floors(key, meta)
    except Exception as exc:
        raise SourceUnavailable('source floors are unavailable') from exc


def ms_date(value, timezone):
    return datetime.fromtimestamp(value / 1000, ZoneInfo(timezone)).date()


def visible_events(rows, start, end, cutoff):
    result = []
    for row in rows:
        if start <= row['offset_ms'] < end:
            row = copy.deepcopy(row)
            resolved = row.get('resolved_offset_ms')
            if resolved is not None and resolved > cutoff:
                row['resolved_offset_ms'] = None
                row['status'] = '待核查'
            result.append(row)
    return result


def lift_window(lift, start, end):
    result = copy.deepcopy(lift)
    # Keep a complete left anchor, plus all intersecting movement/door segments.
    before = [t for t in lift['trips'] if t['depart_ms'] <= start]
    anchor = before[-1:]
    selected = anchor + [t for t in lift['trips'] if start < t['depart_ms'] < end]
    result['trips'] = copy.deepcopy(selected)
    result['initial_floor'] = selected[0]['from_floor'] if selected else lift['initial_floor']
    return result


def window(source, start_ms, end_ms, building_id, kind='window'):
    if not 0 < end_ms - start_ms <= DAY_MS:
        raise ValueError('range must be positive and at most 24 hours')
    calendar = read_calendar()
    timezone = calendar['timezone']
    current, last = ms_date(start_ms, timezone), ms_date(end_ms - 1, timezone)
    days = []
    while current <= last:
        entry = calendar_entry(current, calendar)
        data = load_day(source, entry, building_id, timezone, floors=True)
        base = data['day_start_ms']
        start, end = max(0, start_ms - base), min(DAY_MS, end_ms - base)
        days.append({'day_start_ms': base, 'date': current.isoformat(), 'meta': data['meta'],
                     'hours': [h for h in data['hours'] if h['offset_ms'] < end and h['offset_ms'] + HOUR_MS > start],
                     'elevators': [lift_window(l, start, end) for l in data['elevators']],
                     **{group: visible_events(data[group], start, end, end - 1)
                        for group in ('alerts', 'work_orders', 'agent_order_refs')}})
        current += timedelta(days=1)
    result = {'schema_version': '1.0', 'kind': kind, 'timezone': timezone,
              'start_ms': start_ms, 'end_ms': end_ms, 'days': days}
    if kind == 'history':
        result['agent_records'] = []
        result['agent_records_quality'] = 'unavailable'
    return result


def snapshot(source, at_ms, building_id):
    calendar = read_calendar()
    timezone = calendar['timezone']
    entry = calendar_entry(ms_date(at_ms, timezone), calendar)
    data = load_day(source, entry, building_id, timezone, floors=True)
    offset = at_ms - data['day_start_ms']
    hour = next(h for h in data['hours'] if h['offset_ms'] <= offset < h['offset_ms'] + HOUR_MS)
    return {'schema_version': '1.0', 'kind': 'snapshot', 'at_ms': at_ms,
            'timezone': timezone, 'day_start_ms': data['day_start_ms'], 'meta': data['meta'],
            'hour': hour, 'elevators': [state_at(l, offset) for l in data['elevators']],
            **{group: visible_events(data[group], 0, offset + 1, offset)
               for group in ('alerts', 'work_orders', 'agent_order_refs')}}
