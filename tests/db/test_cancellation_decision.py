"""Cancellation restores decisions while keeping the separate display/audit record."""
import copy
import json
from datetime import datetime,timedelta
import pytest
from fastapi.testclient import TestClient
from src.api import app as api
from src.api.takeover_router import get_service
import src.db as db_module
from src.db import Repository, get_active_takeover
from src.db.connection import ROOT
from src.db.evidence import ExportEvidence
from src.db.standalone import create_app
from src.db.time import ZONE
from src.agent import orchestrator, chat_tools


class LocalProvider:
    def choose_candidate(self,*args,**kwargs):
        return {'choice':{},'llm':{'mode':'rule','reason':'key_unavailable'}}


def finish(generator):
    while True:
        try: next(generator)
        except StopIteration as done: return done.value


def test_create_cancel_restores_export_decision_and_no_current_work_orders(tmp_path,monkeypatch):
    db_path=tmp_path/'cancel.db'
    monkeypatch.setenv('YUNQI_DB_PATH',str(db_path))
    monkeypatch.setattr(api,'OpenAICompatibleProvider',LocalProvider)
    monkeypatch.setattr(orchestrator,'dispatch_to_bms',lambda plan,*args:dict(count=len(plan)*2,elapsed_ms=0.,transport='log_only',device_connected=False))
    clock=lambda:datetime(2026,10,13,3,2,tzinfo=ZONE)
    # Scheduling/chat construct Repository through src.db: use the API's clock there too.
    monkeypatch.setattr(db_module,'Repository',lambda database:Repository(database,clock=clock))
    app=create_app(db_path,clock=clock)
    app.add_api_route('/schedule',api.schedule,methods=['POST'])
    data=json.loads((ROOT/'exports/replay/normal.json').read_bytes())
    raw=data['hours'][3]
    assert raw['agent']['status']=='executed' and not raw['abstain']
    stamp=datetime.fromisoformat(raw['t'])
    schedule=dict(building_id=data['meta']['building_id'],scenario='normal',display_date='2026-10-13',
                  start=raw['t'],end=(stamp+timedelta(hours=1)).isoformat())
    with TestClient(app) as client:
        baseline=client.post('/schedule',json=schedule).json()
        item=client.post('/takeover',json=dict(date='2026-10-13',hour=3,duration_hours=1,
                        operator_id='值班员甲',hvac_setpoint_c=26.2,storage_mode='idle',storage_power_kw=0,
                        reason='检查设备')).json()['takeover']
        assert get_active_takeover('2026-10-13',3)['status']=='manual'
        assert client.post('/schedule',json=schedule).json()['status']=='manual'
        cancel=client.post('/takeover/'+item['id']+'/cancel',json=dict(operator_id='值班员乙',reason='检查结束'))
        assert cancel.status_code==200
        assert get_active_takeover('2026-10-13',3) is None
        shown=client.get('/takeover/active?date=2026-10-13&hour=3').json()['takeover']
        assert shown['status']=='cancelled' and shown['cancelled_by']=='值班员乙'
        assert shown['cancelled_at']=='2026-10-12T19:02:00.000+00:00'
        restored=client.post('/schedule',json=schedule).json()
        assert restored['status']=='executed' and restored['mode']=='auto'
        assert restored['needs_human'] is False
        assert restored['plan']==baseline['plan']
        assert restored['takeovers']==[] and 'active_takeover' not in restored
        current_orders=[w for w in restored['work_orders'] if w['timestamp']==raw['t']]
        assert len(current_orders)==0
        selected=next(c for c in raw['agent']['candidate_summaries'] if c['candidate_id']==raw['agent']['selected'])
        assert round(restored['plan'][0]['hvac_setpoint_c'],1)==round(selected['hvac_setpoint_c'],1)
        assert round(restored['plan'][0]['battery_kw'],1)==round(selected['battery_kw'],1)
        hydrated,_=ExportEvidence().hour('2026-10-13',3)
        original=copy.deepcopy(hydrated)
        # Question tool uses the same decision lookup and the untouched export gate.
        answer=finish(chat_tools.execute('handoff_reason','现在为什么转人工',data,hydrated,
                      display_date='2026-10-13',display_time='03:02'))
        assert answer['needs_human'] is False
        result=next(t['result'] for t in answer['tool_trace'] if t['tool']=='handoff_reason')
        assert result['active_takeover'] is None and result['current_handoff'] is False
        assert not [w for w in result['work_orders'] if w['timestamp']==raw['t']]
        assert hydrated==original
        audits=client.get('/audit?date=2026-10-13').json()['items']
        assert [a['action'] for a in audits]==['create','cancel']
        assert audits[-1]['after']['status']=='cancelled'


def test_decision_and_display_queries_separate_same_hour(repo_clock):
    repository,clock=repo_clock
    item=repository.create(dict(date='2026-10-13',hour=3,duration_hours=2,operator_id='甲',
          hvac_setpoint_c=25.5,storage_mode='idle',storage_power_kw=0,reason='检查设备'),dict(building_id='test'))
    assert repository.get_active('2026-10-13',3)['status']=='manual'
    clock[0]=datetime(2026,10,13,3,5,tzinfo=ZONE)
    repository.cancel(item['id'],'乙','检查结束')
    assert repository.get_active('2026-10-13',3) is None
    assert repository.get_active('2026-10-13',4) is None
    assert repository.get_for_display('2026-10-13',3)['status']=='cancelled'
    assert repository.get_for_display('2026-10-13',4) is None


@pytest.fixture
def repo_clock(tmp_path):
    from src.db import Database,Repository
    clock=[datetime(2026,10,13,3,2,tzinfo=ZONE)]
    return Repository(Database(tmp_path/'repo.db'),lambda:clock[0]),clock


def test_cancel_then_recreate_same_hour_selects_new_manual(tmp_path,monkeypatch):
    db_path=tmp_path/'recreate.db'
    monkeypatch.setenv('YUNQI_DB_PATH',str(db_path))
    monkeypatch.setattr(api,'OpenAICompatibleProvider',LocalProvider)
    monkeypatch.setattr(orchestrator,'dispatch_to_bms',lambda plan,*args:dict(count=len(plan)*2,elapsed_ms=0.,transport='log_only',device_connected=False))
    clock=[datetime(2026,10,13,3,2,tzinfo=ZONE)]
    # Share the mutable clock across API writes and fresh scheduling/chat repositories.
    monkeypatch.setattr(db_module,'Repository',lambda database:Repository(database,clock=lambda:clock[0]))
    app=create_app(db_path,clock=lambda:clock[0])
    app.add_api_route('/schedule',api.schedule,methods=['POST'])
    data=json.loads((ROOT/'exports/replay/normal.json').read_bytes())
    row=data['hours'][3]
    stamp=datetime.fromisoformat(row['t'])
    schedule=dict(building_id=data['meta']['building_id'],scenario='normal',display_date='2026-10-13',
                  start=row['t'],end=(stamp+timedelta(hours=1)).isoformat())
    first=dict(date='2026-10-13',hour=3,duration_hours=1,operator_id='值班员甲',
               hvac_setpoint_c=26.2,storage_mode='idle',storage_power_kw=0,reason='检查设备',request_id='first')
    with TestClient(app) as client:
        created=client.post('/takeover',json=first)
        assert created.status_code==200,created.text
        old=created.json()['takeover']
        # Two uncancelled records overlapping at 03:00 are still rejected.
        conflict=client.post('/takeover',json={**first,'request_id':'overlap'})
        assert conflict.status_code==409
        clock[0]=datetime(2026,10,13,3,5,tzinfo=ZONE)
        assert client.post('/takeover/'+old['id']+'/cancel',json=dict(operator_id='值班员乙',reason='检查结束')).status_code==200
        assert get_active_takeover('2026-10-13',3) is None
        clock[0]=datetime(2026,10,13,3,6,tzinfo=ZONE)
        second={**first,'operator_id':'值班员丙','hvac_setpoint_c':24.8,'reason':'重新检查设备','request_id':'second'}
        recreated=client.post('/takeover',json=second)
        assert recreated.status_code==200,recreated.text
        new=recreated.json()['takeover']
        assert new['id']!=old['id']
        decision=get_active_takeover('2026-10-13',3)
        assert decision['id']==new['id'] and decision['status']=='manual'
        assert decision['hvac_setpoint_c']==24.8 and decision['operator_id']=='值班员丙'
        shown=client.get('/takeover/active?date=2026-10-13&hour=3').json()['takeover']
        assert shown['id']==new['id'] and shown['status']=='manual'
        response=client.post('/schedule',json=schedule)
        assert response.status_code==200,response.text
        result=response.json()
        assert result['status']=='manual' and result['active_takeover']['id']==new['id']
        assert result['plan'][0]['hvac_setpoint_c']==24.8
        assert not [w for w in result['work_orders'] if w['timestamp']==row['t']]
        assert client.post('/takeover',json={**second,'request_id':'second-overlap'}).status_code==409
        history=client.get('/takeover/history?date=2026-10-13').json()['items']
        assert {r['id']:r['status'] for r in history}=={old['id']:'cancelled',new['id']:'active'}
        audits=client.get('/audit?date=2026-10-13').json()['items']
        assert [r['action'] for r in audits]==['create','cancel','create']
