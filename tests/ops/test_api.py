"""Ops HTTP contracts, source isolation, date binding and cross-day tests."""
import copy
import json
import time
from pathlib import Path
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.ops_router import router
from src.ops.config import ROOT, DAY_MS, HOUR_MS, canonical
from src.ops.elevators import state_at
from src.ops.generated import GeneratedOpsSource
from src.ops.source import _read_bytes, get_source, read_calendar
from src.ops.types import OpsDayKey
from src.ops import service
from datetime import date


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv('OPS_SOURCE', 'generated')
    monkeypatch.setenv('OPS_TIMEZONE', 'Asia/Shanghai')
    monkeypatch.delenv('OPS_LIVE_FACTORY', raising=False)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def entry(text):
    return next(r for r in read_calendar()['days'] if r['date'] == text)


@pytest.mark.parametrize('text', ['2026-10-12', '2026-07-20', '2026-10-11'])
def test_day_only_changes_anchor_and_is_repeatable(client, text, monkeypatch):
    monkeypatch.setattr('src.ops.generated.generate', lambda *a: pytest.fail('HTTP must not generate'))
    row = entry(text)
    raw = (ROOT/'exports/replay'/(row['scenario']+'.ops.json')).read_bytes()
    expected = raw.replace(b'"day_start_ms":0', b'"day_start_ms":'+str(row['day_start_ms']).encode(), 1)
    response = client.get('/ops/day', params={'date': text})
    assert response.status_code == 200
    assert response.content == expected
    assert response.content == client.get('/ops/day', params={'date': text}).content
    assert response.headers['etag']
    assert client.get('/ops/snapshot', params={'at_ms': row['day_start_ms']}).status_code == 200
    assert client.get('/ops/day', params={'date': text}).content == expected


def test_cache_reads_only_ops_and_invalidates_on_file_change(client, monkeypatch, tmp_path):
    _read_bytes.cache_clear()
    reads = []
    original = Path.read_bytes
    def counted(path):
        reads.append(path)
        assert path.name.endswith(('.ops.json', '.ops-floors.json')) or path.name == 'ops-calendar.json'
        return original(path)
    monkeypatch.setattr(Path, 'read_bytes', counted)
    base = entry('2026-10-12')['day_start_ms']
    for _ in range(2):
        assert client.get('/ops/day', params={'date': '2026-10-12'}).status_code == 200
        assert client.get('/ops/snapshot', params={'at_ms': base+8*HOUR_MS}).status_code == 200
    assert len(reads) == 3 and len(set(reads)) == 3
    from src.ops.source import read_export
    path = tmp_path/'test.ops.json'
    path.write_bytes(b'first')
    assert read_export(path) == b'first'
    path.write_bytes(b'changed')
    assert read_export(path) == b'changed'
    _read_bytes.cache_clear()


@pytest.mark.parametrize('endpoint', ['window', 'history'])
def test_cross_midnight_routes_two_different_days(client, endpoint):
    a, b = entry('2026-10-11'), entry('2026-10-12')
    start, end = a['day_start_ms']+22*HOUR_MS, b['day_start_ms']+2*HOUR_MS
    response = client.get('/ops/'+endpoint, params={'start_ms': start, 'end_ms': end})
    assert response.status_code == 200
    out = response.json()
    assert out['kind'] == endpoint and len(out['days']) == 2
    assert [d['meta']['scenario'] for d in out['days']] == ['abstain', 'normal']
    assert [d['meta']['source_date'] for d in out['days']] == [a['source_date'], b['source_date']]
    for d, offsets in zip(out['days'], ([22*HOUR_MS,23*HOUR_MS],[0,HOUR_MS])):
        assert [h['offset_ms'] for h in d['hours']] == offsets
        assert all(len(h['floors']) == 40 for h in d['hours'])
        for group in ('alerts','work_orders','agent_order_refs'):
            assert all(start <= d['day_start_ms']+r['offset_ms'] < end for r in d[group])
    if endpoint == 'history':
        assert out['agent_records'] == [] and out['agent_records_quality'] == 'unavailable'
    assert response.content == client.get('/ops/'+endpoint, params={'start_ms':start,'end_ms':end}).content


def test_snapshot_and_window_share_lift_position(client):
    row = entry('2026-10-12')
    key = OpsDayKey(row['scenario'], date.fromisoformat(row['source_date']))
    day = GeneratedOpsSource().read_day(key)
    trip = next(t for t in day['elevators'][0]['trips'] if t['depart_ms'] > 8*HOUR_MS)
    offset = (trip['depart_ms']+trip['arrive_ms'])//2
    at = row['day_start_ms']+offset
    out = client.get('/ops/snapshot',params={'at_ms':at}).json()
    assert out['elevators'] == [state_at(l,offset) for l in day['elevators']]
    assert out['hour']['offset_ms'] <= offset < out['hour']['offset_ms']+HOUR_MS
    for group in ('alerts','work_orders','agent_order_refs'):
        assert all(r['offset_ms'] <= offset for r in out[group])
    win = client.get('/ops/window',params={'start_ms':at,'end_ms':at+60000}).json()['days'][0]
    assert [state_at(l,offset) for l in win['elevators']] == out['elevators']
    assert trip in win['elevators'][0]['trips']


def test_no_future_recovery_is_shown():
    rows = [{'id':'x','offset_ms':0,'resolved_offset_ms':HOUR_MS,'status':'已恢复'}]
    out = service.visible_events(rows,0,HOUR_MS//2,HOUR_MS//2-1)
    assert out[0]['resolved_offset_ms'] is None and out[0]['status'] == '待核查'
    assert rows[0]['status'] == '已恢复'
    assert service.visible_events(rows,0,2*HOUR_MS,2*HOUR_MS-1)[0]['status'] == '已恢复'


@pytest.mark.parametrize('mode,factory', [('live',''),('live','missing_ops_module:create'),('bad','')])
def test_source_unavailable_never_falls_back(client, monkeypatch, mode, factory):
    monkeypatch.setenv('OPS_SOURCE',mode)
    monkeypatch.setenv('OPS_LIVE_FACTORY',factory)
    monkeypatch.setattr(GeneratedOpsSource,'read_day',lambda *a: pytest.fail('must not fall back'))
    for route,params in [('floors',{'date':'2026-10-12'}),('day',{'date':'2026-10-12'}),
                         ('snapshot',{'at_ms':0}),('window',{'start_ms':0,'end_ms':1}),
                         ('history',{'start_ms':0,'end_ms':1})]:
        assert client.get('/ops/'+route,params=params).status_code == 503


def test_time_and_invalid_requests(client):
    before = time.time_ns()//1000000
    response = client.get('/ops/time')
    assert before <= response.json()['epoch_ms'] <= time.time_ns()//1000000
    assert response.json()['timezone'] == 'Asia/Shanghai'
    assert response.headers['cache-control'] == 'no-store'
    base = entry('2026-10-12')['day_start_ms']
    for route,params in [('day',{'date':'2026-1-1'}),('day',{'date':'2025-12-31'}),
                         ('day',{'date':'2026-10-12','building_id':'bad'}),
                         ('snapshot',{'at_ms':-1}),('snapshot',{'at_ms':0}),
                         ('window',{'start_ms':base,'end_ms':base}),
                         ('window',{'start_ms':base,'end_ms':base+DAY_MS+1}),
                         ('history',{'start_ms':entry('2026-01-01')['day_start_ms']-1,
                                     'end_ms':entry('2026-01-01')['day_start_ms']+1})]:
        assert client.get('/ops/'+route,params=params).status_code == 422



def test_live_factory_and_read_failure_are_not_generated(client, monkeypatch):
    import sys
    import types
    from src.ops.source import _factory
    sample = GeneratedOpsSource().read_day(OpsDayKey('normal',date(2017,10,23)))
    sample['meta']['provider'] = 'live'
    calls = []
    class Live:
        def read_day(self,key):
            calls.append(key)
            return copy.deepcopy(sample)
        def read_floors(self,key,meta):
            raise RuntimeError('not connected')
        def connections(self,key):
            return []
    module = types.ModuleType('ops_test_live_adapter')
    module.create = Live
    monkeypatch.setitem(sys.modules,module.__name__,module)
    monkeypatch.setenv('OPS_SOURCE','live')
    monkeypatch.setenv('OPS_LIVE_FACTORY','ops_test_live_adapter:create')
    _factory.cache_clear()
    try:
        result = client.get('/ops/day',params={'date':'2026-10-12'})
        assert result.status_code == 200 and result.json()['meta']['provider'] == 'live'
        assert len(calls) == 1
        monkeypatch.setattr(Live,'read_day',lambda *a: (_ for _ in ()).throw(ValueError('device unavailable')))
        assert client.get('/ops/day',params={'date':'2026-10-12'}).status_code == 503
        monkeypatch.setattr(Live,'read_day',lambda *a: GeneratedOpsSource().read_day(OpsDayKey('normal',date(2017,10,23))))
        assert client.get('/ops/day',params={'date':'2026-10-12'}).status_code == 503
    finally:
        _factory.cache_clear()


def test_corrupt_or_missing_exports_fail_closed(client, monkeypatch):
    import src.ops.generated as generated
    original = generated.GeneratedOpsSource.read_floors
    monkeypatch.setattr(generated.GeneratedOpsSource,'read_floors',lambda *a: (_ for _ in ()).throw(RuntimeError('digest mismatch')))
    base = entry('2026-10-12')['day_start_ms']
    assert client.get('/ops/snapshot',params={'at_ms':base}).status_code == 503
    monkeypatch.setattr(generated.GeneratedOpsSource,'read_floors',original)
    monkeypatch.setattr(generated.GeneratedOpsSource,'read_day',lambda *a: (_ for _ in ()).throw(FileNotFoundError()))
    assert client.get('/ops/day',params={'date':'2026-10-12'}).status_code == 503


def test_full_app_registers_ops_router():
    from src.api.app import app
    paths = set(app.openapi()['paths'])
    assert {'/ops/'+name for name in ('time','day','floors','window','snapshot','history')} <= paths



def test_floor_digest_is_checked(tmp_path):
    from src.ops.source import _read_bytes
    source = GeneratedOpsSource(root=tmp_path)
    row = entry('2026-10-12')
    raw = (ROOT/'exports/replay/normal.ops.json').read_bytes()
    (tmp_path/'normal.ops.json').write_bytes(raw)
    (tmp_path/'normal.ops-floors.json').write_bytes(b'{}')
    key = OpsDayKey('normal',date.fromisoformat(row['source_date']))
    data = source.read_day(key)
    with pytest.raises(RuntimeError,match='digest mismatch'):
        source.read_floors(key,data['meta'])
    _read_bytes.cache_clear()



@pytest.mark.parametrize('text', ['2026-10-12', '2026-07-20'])
def test_floors_bytes_match_export_and_digest(client, text):
    import hashlib
    row = entry(text)
    meta = client.get('/ops/day',params={'date':text}).json()['meta']
    expected = (ROOT/'exports/replay'/meta['floors_file']).read_bytes()
    result = client.get('/ops/floors',params={'date':text})
    assert result.status_code == 200 and result.content == expected
    assert hashlib.sha256(result.content).hexdigest() == meta['floors_sha256']
    assert result.content == client.get('/ops/floors',params={'date':text}).content
    assert result.json()['source_date'] == row['source_date']
    assert 'day_start_ms' not in result.json()


def test_inline_floors_return_404_without_reading_sidecar(client, monkeypatch):
    monkeypatch.setattr(GeneratedOpsSource,'read_floors',lambda *a: pytest.fail('inline floors have no sidecar'))
    result = client.get('/ops/floors',params={'date':'2026-10-11'})
    assert result.status_code == 404 and '/ops/day' in result.json()['detail']
    assert all(len(h['floors']) == 40 for h in client.get('/ops/day',params={'date':'2026-10-11'}).json()['hours'])


@pytest.mark.parametrize('params', [{}, {'date':'2026-1-1'}, {'date':'2025-12-31'},
                                    {'date':'2026-10-12','building_id':'bad'}])
def test_floors_invalid_requests(client, params):
    assert client.get('/ops/floors',params=params).status_code == 422


def test_floors_read_failure_returns_503(client, monkeypatch):
    monkeypatch.setattr(GeneratedOpsSource,'read_floors',lambda *a: (_ for _ in ()).throw(RuntimeError('digest mismatch')))
    assert client.get('/ops/floors',params={'date':'2026-10-12'}).status_code == 503


@pytest.mark.parametrize('mode', ['live','generated','bad'])
def test_time_never_touches_source_or_calendar(client, monkeypatch, mode):
    monkeypatch.setenv('OPS_SOURCE',mode)
    monkeypatch.setenv('OPS_LIVE_FACTORY','missing_ops_module:create')
    monkeypatch.setattr('src.api.ops_router.get_source',lambda: pytest.fail('time must not load source'))
    monkeypatch.setattr(service,'read_calendar',lambda: pytest.fail('time must not read calendar'))
    before = time.time_ns()//1000000
    result = client.get('/ops/time')
    assert result.status_code == 200
    assert before <= result.json()['epoch_ms'] <= time.time_ns()//1000000
    assert result.json()['timezone'] == 'Asia/Shanghai'
    assert result.headers['cache-control'] == 'no-store'
