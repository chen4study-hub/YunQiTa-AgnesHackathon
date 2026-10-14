import concurrent.futures
import json
import sqlite3
from datetime import datetime
from pathlib import Path
import pytest
from src.db import Database, Repository
from src.db.connection import ROOT, database_path
from src.db.evidence import BANNED
from src.db.time import ZONE
from test_takeover_api import payload


@pytest.mark.parametrize('changes',[
    {'hvac_setpoint_c':23.9},{'hvac_setpoint_c':27.1},{'storage_power_kw':501},
    {'storage_mode':'charge','storage_power_kw':0},{'storage_mode':'idle','storage_power_kw':1},
    {'storage_mode':'discharge','storage_power_kw':-1},{'hour':24},{'hour':True},
    {'duration_hours':0},{'duration_hours':25},{'date':'20261012'},
    {'recommendation_hash':'wrong'}, {'reason':'演示配置'},
    {'storage_power_kw':True}, {'hvac_setpoint_c':'25.5'},
])
def test_validation(client,changes):
    data=payload()
    data.update(changes)
    result=client.post('/takeover',json=data)
    assert result.status_code in (422,409)
    assert client.get('/takeover/history?date=2026-10-12').json()['items']==[]


def test_soc_duration_and_missing_context(client):
    data=payload();data.update(storage_mode='discharge',storage_power_kw=500,duration_hours=24)
    assert client.post('/takeover',json=data).status_code==422
    data=payload();data.update(date='2027-12-31',hour=23,duration_hours=2)
    assert client.post('/takeover',json=data).status_code==503


def test_optional_hash_and_overlap(client):
    assert client.post('/takeover',json=payload()).status_code==200
    assert client.post('/takeover',json=payload()).status_code==409
    data=payload();data['hour']=12
    assert client.post('/takeover',json=data).status_code==200


def test_expiry_and_cancellation_boundary(client,clock):
    item=client.post('/takeover',json=payload()).json()['takeover']
    clock[0]=datetime(2026,10,12,10,tzinfo=ZONE)
    assert client.post('/takeover/'+item['id']+'/cancel',json=dict(operator_id='值班员甲',reason='调整计划')).status_code==200
    assert client.get('/takeover/active?date=2026-10-12&hour=10').json()['takeover'] is None
    # A recorded log receipt remains history, not proof that it is still effective.
    result=client.get('/dispatch/receipt?date=2026-10-12&hour=10&operator_id=reader').json()
    assert result['records'] and not any(r['effective'] for r in result['records'])
    assert result['active_takeover'] is None
    other=client.post('/takeover',json=payload()).json()['takeover']
    clock[0]=datetime(2026,10,12,12,tzinfo=ZONE)
    history=client.get('/takeover/history?date=2026-10-12').json()['items']
    assert next(x for x in history if x['id']==other['id'])['status']=='expired'
    assert client.get('/takeover/active?date=2026-10-12&hour=10').json()['takeover']['record_status']=='expired'


def test_cross_midnight_and_update_audit(client):
    data=payload();data.update(hour=23,duration_hours=2)
    item=client.post('/takeover',json=data).json()['takeover']
    assert client.get('/takeover/active?date=2026-10-13&hour=0').json()['takeover']['id']==item['id']
    data.update(hour=22,hvac_setpoint_c=26,expected_version=1)
    changed=client.patch('/takeover/'+item['id'],json=data)
    assert changed.status_code==200,changed.text
    assert changed.json()['takeover']['version']==2
    assert client.patch('/takeover/'+item['id'],json=data).status_code==409
    audits=client.get('/audit?date=2026-10-12').json()['items']
    assert audits[-1]['action']=='update'
    assert audits[-1]['before']['hvac_setpoint_c']==25.2
    assert audits[-1]['after']['hvac_setpoint_c']==26
    assert client.get('/takeover/active?date=2026-10-13&hour=0').json()['takeover'] is None


def test_migrations_path_wal_and_atomicity(tmp_path,monkeypatch):
    db=Database(tmp_path/'db.sqlite');db.migrate();db.migrate()
    with db.transaction() as conn:
        assert conn.execute('PRAGMA journal_mode').fetchone()[0]=='wal'
        assert conn.execute('PRAGMA foreign_keys').fetchone()[0]==1
        assert conn.execute('SELECT COUNT(*) FROM schema_version').fetchone()[0]==1
    monkeypatch.setenv('DATABASE_URL','sqlite:///data/other.db')
    monkeypatch.delenv('YUNQI_DB_PATH',raising=False)
    assert database_path()==ROOT/'data/other.db'
    monkeypatch.setenv('YUNQI_DB_PATH',str(tmp_path/'override.db'))
    assert database_path()==tmp_path/'override.db'
    monkeypatch.delenv('YUNQI_DB_PATH')
    monkeypatch.setenv('DATABASE_URL','postgresql://localhost/database')
    with pytest.raises(ValueError): database_path()
    migration=tmp_path/'migrations';migration.mkdir()
    content=(ROOT/'migrations/0001_takeover.sql').read_text()
    (migration/'0001_takeover.sql').write_text(content)
    corrupt=Database(tmp_path/'corrupt.db',migration);corrupt.migrate()
    (migration/'0001_takeover.sql').write_text(content+'\n-- changed\n')
    with pytest.raises(RuntimeError): corrupt.migrate()
    bad=tmp_path/'bad';bad.mkdir()
    (bad/'0001_bad.sql').write_text('CREATE TABLE partial(x);\nINVALID SQL;\n')
    partial=Database(tmp_path/'partial.db',bad)
    with pytest.raises(sqlite3.OperationalError): partial.migrate()
    conn=partial.connect()
    try: assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='partial'").fetchone()
    finally: conn.close()


def test_write_and_dispatch_rollback_and_concurrent_overlap(tmp_path,clock):
    repository=Repository(Database(tmp_path/'concurrent.db'),lambda:clock[0])
    snapshot=dict(building_id='test',available=False)
    original=repository.dispatch
    def fail(*args): raise RuntimeError('dispatch failure')
    repository.dispatch=fail
    with pytest.raises(RuntimeError): repository.create(payload(),snapshot)
    assert repository.history('2026-10-12')==[]
    repository.dispatch=original
    from src.db.repository import Conflict
    def create():
        try: repository.create(payload(),snapshot);return True
        except Conflict: return False
    with concurrent.futures.ThreadPoolExecutor(2) as executor:
        assert sum(executor.map(lambda _:create(),range(2)))==1
    with repository.db.transaction() as conn:
        assert conn.execute('SELECT COUNT(*) FROM dispatch_log').fetchone()[0]==4
        with pytest.raises(sqlite3.IntegrityError): conn.execute('DELETE FROM audit_log')


def test_agent_receipt_storage(tmp_path):
    repository=Repository(Database(tmp_path/'agent.db'))
    commands=[dict(destination='BA',command=dict(setpoint_c=25.5)),dict(destination='EMS',command=dict(battery_kw=-20))]
    receipt=dict(count=2,elapsed_ms=1,transport='log_only',device_connected=False)
    for _ in range(2): repository.record_agent_dispatch('2026-10-12',12,'test',commands,receipt,'request-1')
    records=repository.receipts('2026-10-12',12)
    assert len(records)==2 and all(r['source']=='agent' for r in records)


def test_owned_chinese_text_no_banned_terms():
    # Word list is the validator itself, not user-facing prose.
    import ast
    for folder in (ROOT/'src/db',ROOT/'src/api'):
        paths=folder.glob('*.py') if folder.name=='db' else [folder/'takeover_router.py']
        for path in paths:
            tree=ast.parse(path.read_text(encoding='utf-8-sig'))
            for node in ast.walk(tree):
                if isinstance(node,ast.Constant) and isinstance(node.value,str) and node.value not in BANNED:
                    assert not any(w in node.value for w in BANNED),(path,node.value)
