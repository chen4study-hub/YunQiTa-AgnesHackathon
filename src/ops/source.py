"""Configured source selection and bounded immutable-byte cache."""
import importlib
import json
from functools import lru_cache
from .config import ROOT, settings


class SourceUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=32)
def _read_bytes(path, size, modified):
    return path.read_bytes()


def read_export(path):
    info = path.stat()
    return _read_bytes(path, info.st_size, info.st_mtime_ns)


def read_calendar():
    try:
        result = json.loads(read_export(ROOT/'exports/replay/ops-calendar.json'))
    except Exception as exc:
        raise SourceUnavailable('ops calendar unavailable') from exc
    if result['timezone'] != settings()['timezone']:
        raise SourceUnavailable('calendar timezone differs from OPS_TIMEZONE')
    return result


@lru_cache(maxsize=4)
def _factory(spec):
    module, sep, name = spec.partition(':')
    if not sep or not module or not name:
        raise SourceUnavailable('OPS_LIVE_FACTORY must be module:factory')
    source = getattr(importlib.import_module(module), name)()
    if not all(callable(getattr(source, method, None)) for method in ('read_day', 'read_floors', 'connections')):
        raise SourceUnavailable('live source does not implement OpsSource')
    return source


def get_source():
    config = settings()
    if config['source'] == 'generated':
        from .generated import GeneratedOpsSource
        return GeneratedOpsSource()
    if config['source'] == 'live':
        if not config['live_factory']:
            raise SourceUnavailable('live source is not connected')
        try:
            return _factory(config['live_factory'])
        except Exception as exc:
            raise SourceUnavailable('live source is unavailable') from exc
    raise SourceUnavailable('OPS_SOURCE must be generated or live')
