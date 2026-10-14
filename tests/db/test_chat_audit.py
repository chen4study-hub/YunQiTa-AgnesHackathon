"""Chat audit filtering never leaks into the default operator log."""
import sqlite3
from datetime import datetime
import pytest
from fastapi.testclient import TestClient
import src.db as db_module
from src.db import Database, Repository, record_chat_event
from src.db.standalone import create_app
from src.db.time import ZONE


def test_public_chat_writer_and_audit_filter(tmp_path,monkeypatch):
    path=tmp_path/'chat.db'
    clock=lambda:datetime(2026,10,13,11,2,tzinfo=ZONE)
    monkeypatch.setenv('YUNQI_DB_PATH',str(path))
    monkeypatch.setattr(db_module,'Repository',lambda database:Repository(database,clock=clock))
    question='  请讨论当前政治新闻的观点。\n保留问题原文。  '
    identifier=record_chat_event('session-123',question,'politics','问题涉及政治评论',
                                 operator_id='classifier',request_id='request-456')
    assert isinstance(identifier,int)
    repo=Repository(Database(path),clock)
    with repo.db.transaction() as connection:
        # Existing default classification remains unchanged.
        repo.audit(connection,'甲','create','takeover-id',after={'status':'active'})
        repo.audit(connection,'甲','view_receipt','receipt-id',after={'count':2})
    with TestClient(create_app(path,clock=clock)) as client:
        default=client.get('/audit?date=2026-10-13').json()['items']
        assert [r['entity_type'] for r in default]==['takeover','receipt']
        assert identifier not in [r['id'] for r in default]
        response=client.get('/audit?date=2026-10-13&entity_type=chat')
        assert response.status_code==200 and response.headers['cache-control']=='no-store'
        rows=response.json()['items']
        assert len(rows)==1
        row=rows[0]
        assert row['id']==identifier and row['action']=='chat_terminated'
        assert row['entity_type']=='chat' and row['entity_id']=='session-123'
        assert row['operator_id']=='classifier' and row['request_id']=='request-456'
        assert row['before'] is None
        assert row['occurred_at']=='2026-10-13T03:02:00.000+00:00'
        assert row['after']==dict(occurred_at=row['occurred_at'],session_id='session-123',
                                 question=question,classification='politics',reason='问题涉及政治评论')
        for kind in ('takeover','receipt'):
            filtered=client.get('/audit',params={'date':'2026-10-13','entity_type':kind}).json()['items']
            assert len(filtered)==1 and filtered[0]['entity_type']==kind
        assert client.get('/audit?date=2026-10-13&entity_type=unknown').status_code==422
        assert client.get('/audit?date=2026-10-12&entity_type=chat').json()['items']==[]
    for sql in ('UPDATE audit_log SET action=\'changed\' WHERE id=?',
                'DELETE FROM audit_log WHERE id=?'):
        with pytest.raises(sqlite3.IntegrityError,match='append-only'):
            with repo.db.transaction() as connection:
                connection.execute(sql,(identifier,))
    assert repo.audits('2026-10-13',entity_type='chat')[0]['after']['question']==question


def test_chat_pagination_filters_before_limit(tmp_path):
    clock=lambda:datetime(2026,10,13,11,2,tzinfo=ZONE)
    repo=Repository(Database(tmp_path/'pagination.db'),clock)
    for index in range(3):
        repo.record_chat_event(f'session-{index}',f'问题 {index}','current_affairs','问题涉及时事')
        with repo.db.transaction() as connection:
            repo.audit(connection,'operator','create',f'takeover-{index}')
    assert [r['entity_id'] for r in repo.audits('2026-10-13',limit=1,offset=1)]==['takeover-1']
    assert [r['entity_id'] for r in repo.audits('2026-10-13',limit=1,offset=1,entity_type='chat')]==['session-1']


def test_chat_write_rolls_back_on_failure(tmp_path,monkeypatch):
    repo=Repository(Database(tmp_path/'rollback.db'))
    original=repo.audit
    def fail(*args,**kwargs):
        original(*args,**kwargs)
        raise RuntimeError('failed audit transaction')
    monkeypatch.setattr(repo,'audit',fail)
    with pytest.raises(RuntimeError):
        repo.record_chat_event('session','问题','politics','分类理由')
    with repo.db.transaction() as connection:
        assert connection.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0]==0
