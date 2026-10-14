"""Backend date routing with explicit coverage."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from .config import ROOT, settings
import json
from .git_evidence import head_revision,committed_export

HOLIDAYS = (('2026-01-01','2026-01-03'),('2026-02-15','2026-02-23'),
 ('2026-04-04','2026-04-06'),('2026-05-01','2026-05-05'),
 ('2026-06-19','2026-06-21'),('2026-09-25','2026-09-27'),('2026-10-01','2026-10-07'))
WORKDAYS = ('2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10')


def parse_date(value):
    result = date.fromisoformat(value)
    if result.isoformat() != value:
        raise ValueError('expected YYYY-MM-DD')
    return result


def route(day):
    if day.year not in (2026, 2027):
        raise ValueError('supported dates: 2026-2027')
    text = day.isoformat()
    holiday = any(a <= text <= b for a, b in HOLIDAYS)
    work = text in WORKDAYS or (day.weekday() < 5 and not holiday)
    return 'abstain' if not work else 'peak' if 6 <= day.month <= 8 else 'normal'


def day_start_ms(day):
    return int(datetime(day.year, day.month, day.day,
        tzinfo=ZoneInfo(settings()['timezone'])).timestamp() * 1000)


def document(revision=None):
    revision = revision or head_revision()
    sources = {s: json.loads(committed_export(s,revision))['meta']['date']
               for s in ('normal','peak','abstain')}
    rows = []
    day = date(2026,1,1)
    while day < date(2028,1,1):
        scenario = route(day)
        rows.append({'date':day.isoformat(),'scenario':scenario,
                     'source_date':sources[scenario],'day_start_ms':day_start_ms(day)})
        day += timedelta(days=1)
    return {'schema_version':'1.0','kind':'calendar','timezone':settings()['timezone'],
        'days':rows,'rule_version':'ops-calendar-1.0',
        'policy':{'2026':'published_holidays_and_makeup_workdays',
                  '2027':'weekends_only_pending_published_calendar'},
        'calendar_reference':'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'}
