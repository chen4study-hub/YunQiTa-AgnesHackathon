import copy
import json
from datetime import datetime, timedelta
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from src.db import Database, Repository, TakeoverService
from src.db.connection import ROOT
from src.db.evidence import ExportEvidence, BANNED
from src.db.standalone import create_app
from src.db.time import ZONE
from src.db.precision import display_precision
from src.agent.manual_reference import manual_reference_at


@pytest.fixture
def clock():
    value=[datetime(2026,10,12,8,30,tzinfo=ZONE)]
    return value


@pytest.fixture
def client(tmp_path,clock):
    app=create_app(tmp_path/'test.db',clock=lambda:clock[0])
    with TestClient(app) as value:
        yield value


def payload(**changes):
    return dict(date='2026-10-12',hour=10,duration_hours=2,operator_id='值班员甲',
                hvac_setpoint_c=25.2,storage_mode='idle',storage_power_kw=0,reason='核对设备后调整温控',**changes)


def test_recommendations_equal_each_export_hour(client):
    evidence=ExportEvidence()
    for date in ('2026-10-12','2026-07-13','2026-10-11'):
        for hour in range(24):
            row,_=evidence.hour(date,hour)
            agent=row['agent']
            response=client.get('/takeover/recommendation',params=dict(date=date,hour=hour))
            assert response.status_code==200
            rec=response.json()
            assert response.headers['cache-control']=='no-store'
            if agent['status']=='executed':
                candidate=next(c for c in agent['candidates'] if c['candidate_id']==agent['selected'])
                command=display_precision(next(p for p in candidate['plan'] if p['timestamp']==row['t']))
                assert rec['available']
                assert rec['hvac_setpoint_c']==command['hvac_setpoint_c']
                assert rec['battery_kw']==command['battery_kw']
                assert rec['reason']==agent['explanation']
                assert rec['storage_power_kw']==abs(command['battery_kw'])
            else:
                source_time=datetime.fromisoformat(row['t'])
                reference=display_precision(manual_reference_at(agent,source_time.date().isoformat(),source_time.hour))
                if reference is not None:
                    assert rec['available'] and rec['basis']=='manual_reference'
                    assert rec['hvac_setpoint_c']==reference['hvac_setpoint_c']
                    assert rec['battery_kw']==reference['battery_kw']
                    assert rec['storage_mode']==reference['storage_mode']
                    assert rec['storage_power_kw']==abs(reference['battery_kw'])
                    assert rec['duration_hours']==reference['remaining_duration_hours']
                    assert rec['reason']==reference['reason']
                else:
                    assert not rec['available']
                    assert rec['message']=='推荐暂不可用'
                    assert 'hvac_setpoint_c' not in rec and 'battery_kw' not in rec
            assert not any(w in json.dumps(rec,ensure_ascii=False) for w in BANNED)


@pytest.mark.parametrize('missing',['selected','candidates','explanation','temperature','power'])
def test_missing_executed_fields_unavailable(missing):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-12',12)
    if missing in ('temperature','power'):
        command=next(c for c in row['agent']['candidates'] if c['candidate_id']==row['agent']['selected'])['plan'][0]
        del command['hvac_setpoint_c' if missing=='temperature' else 'battery_kw']
    else:
        del row['agent'][missing]
    evidence.hour=lambda *args:(row,source)
    result=evidence.recommendation('2026-10-12',12)
    assert not result['available'] and result['message']=='推荐暂不可用'


@pytest.mark.parametrize('mode,power',[('charge',-42.5),('discharge',35.7),('idle',0)])
@pytest.mark.parametrize('whole_segment',[False,True])
def test_manual_reference_array_uses_source_local_time(tmp_path,mode,power,whole_segment):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-11',12)
    # Source local noon differs from both the display date and its Shanghai hour.
    source_time=datetime.fromisoformat(row['t'])
    assert source_time.date().isoformat()!='2026-10-11'
    assert source_time.astimezone(ZONE).hour!=12
    reference=dict(timestamp=row['t'],hvac_setpoint_c=26.1,storage_mode=mode,battery_kw=power,
                   suggested_duration_hours=5,remaining_duration_hours=2,reason='设备核查后调整储能')
    refs=[reference]
    if whole_segment:
        refs=[{**reference,'timestamp':(source_time-timedelta(hours=1)).isoformat(),'remaining_duration_hours':3},
              reference,{**reference,'timestamp':(source_time+timedelta(hours=1)).isoformat(),'remaining_duration_hours':1}]
    # A display-date match must not be used instead of the source-date match.
    refs.append({**reference,'timestamp':'2026-10-11T12:00:00+08:00','hvac_setpoint_c':24.4})
    row['agent']['manual_reference']=refs
    evidence.hour=lambda *args:(copy.deepcopy(row),source)
    with TestClient(create_app(tmp_path/'sample.db',evidence=evidence)) as client:
        rec=client.get('/takeover/recommendation?date=2026-10-11&hour=12').json()
    assert rec['available'] and rec['basis']=='manual_reference'
    assert rec['date']=='2026-10-11' and rec['hour']==12
    assert rec['hvac_setpoint_c']==26.1 and rec['battery_kw']==power
    assert rec['storage_mode']==mode and rec['storage_power_kw']==abs(power)
    assert rec['duration_hours']==2 and rec['reason']==reference['reason']
    assert not any(w in json.dumps(rec,ensure_ascii=False) for w in BANNED)


@pytest.mark.parametrize('missing',['manual_reference','empty','wrong_date','wrong_hour',
                                     'hvac_setpoint_c','battery_kw','storage_mode','remaining_duration_hours','reason'])
def test_manual_reference_unavailable_without_matching_complete_reference(missing):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-11',12)
    reference=dict(timestamp=row['t'],hvac_setpoint_c=26.1,storage_mode='charge',battery_kw=-42.5,
                   remaining_duration_hours=2,reason='设备核查后充电')
    row['agent']['manual_reference']=[reference]
    if missing=='manual_reference':
        del row['agent']['manual_reference']
    elif missing=='empty':
        row['agent']['manual_reference']=[]
    elif missing=='wrong_date':
        reference['timestamp']='2026-10-11T12:00:00+08:00'
    elif missing=='wrong_hour':
        reference['timestamp']=(datetime.fromisoformat(row['t'])+timedelta(hours=1)).isoformat()
    else:
        del reference[missing]
    evidence.hour=lambda *args:(row,source)
    result=evidence.recommendation('2026-10-11',12)
    assert not result['available'] and result['message']=='推荐暂不可用'
    assert 'hvac_setpoint_c' not in result and 'battery_kw' not in result


def test_create_reload_cancel_and_hour_coverage(client,tmp_path,clock):
    rec=client.get('/takeover/recommendation?date=2026-10-12&hour=10').json()
    data=payload(recommendation_hash=rec['recommendation_hash'],request_id='test-1')
    created=client.post('/takeover',json=data)
    assert created.status_code==200,created.text
    item=created.json()['takeover']
    assert item['recommendation_snapshot']['recommendation_hash']==rec['recommendation_hash']
    assert item['start_at']=='2026-10-12T10:00:00+08:00'
    assert client.post('/takeover',json=data).json()['takeover']['id']==item['id']
    with TestClient(create_app(tmp_path/'test.db',clock=lambda:clock[0])) as other:
        active=other.get('/takeover/active?date=2026-10-12&hour=11').json()['takeover']
        assert active['id']==item['id'] and active['status']=='manual'
    assert client.get('/takeover/active?date=2026-10-12&hour=12').json()['takeover'] is None
    clock[0]=datetime(2026,10,12,10,30,tzinfo=ZONE)
    cancel=client.post('/takeover/'+item['id']+'/cancel',json=dict(operator_id='值班员乙',reason='检查结束'))
    assert cancel.status_code==200
    cancelled=client.get('/takeover/active?date=2026-10-12&hour=10').json()['takeover']
    assert cancelled['status']=='cancelled' and cancelled['record_status']=='cancelled'
    assert cancelled['cancelled_by']=='值班员乙' and cancelled['cancelled_at']
    assert client.get('/takeover/active?date=2026-10-12&hour=11').json()['takeover'] is None
    assert client.get('/takeover/history?date=2026-10-12').json()['items'][0]['status']=='cancelled'


def test_receipt_fallback_and_manual_audit(client):
    agent=client.get('/dispatch/receipt',params=dict(date='2026-10-12',hour=10,operator_id='值班员甲'))
    assert agent.status_code==200
    row,_=ExportEvidence().hour('2026-10-12',10)
    assert agent.json()['source']=='agent'
    assert agent.json()['actions']==row['agent']['actions']
    assert agent.json()['receipt']==row['agent']['receipt']
    assert client.post('/takeover',json=payload()).status_code==200
    response=client.get('/dispatch/receipt',params=dict(date='2026-10-12',hour=10,operator_id='值班员甲')).json()
    assert response['source']=='manual' and len(response['records'])==2
    assert response['receipt']['device_connected'] is False
    assert {r['destination'] for r in response['records']}=={'BA','EMS'}
    assert next(r['command'] for r in response['records'] if r['destination']=='BA')=={'setpoint_c':25.2}
    audits=client.get('/audit?date=2026-10-12').json()['items']
    assert [a['action'] for a in audits]==['view_receipt','create','view_receipt']
    assert audits[1]['after']['hvac_setpoint_c']==25.2
    assert audits[0]['operator_id']=='值班员甲'


def test_corrupt_companion_and_changed_export_unavailable(tmp_path):
    import hashlib
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-12',12)
    main=dict(meta=dict(date=source['source_date'],building_id=source['building_id'],agent_detail_file='normal.agent-detail.json'),hours=[copy.deepcopy(row)])
    main['hours'][0]['agent']={'detail_index':12}
    raw=json.dumps(main).encode()
    (tmp_path/'normal.json').write_bytes(raw)
    detail=dict(main_sha256='bad',building_id=source['building_id'],scenario='normal',hours={'12':dict(t=row['t'],agent=row['agent'])})
    (tmp_path/'normal.agent-detail.json').write_text(json.dumps(detail),encoding='utf-8')
    from src.db.evidence import EvidenceUnavailable
    with pytest.raises(EvidenceUnavailable): ExportEvidence(tmp_path).hour('2026-10-12',12)
    detail['main_sha256']=hashlib.sha256(raw).hexdigest()
    (tmp_path/'normal.agent-detail.json').write_text(json.dumps(detail),encoding='utf-8')
    assert ExportEvidence(tmp_path).recommendation('2026-10-12',12)['available']


def test_lifespan_migrates_alongside_app_handler(tmp_path):
    from fastapi import FastAPI
    from contextlib import asynccontextmanager
    from src.api.takeover_router import router,get_service
    events=[]
    @asynccontextmanager
    async def lifespan(app):
        events.append('start')
        yield
        events.append('stop')
    service=TakeoverService(Repository(Database(tmp_path/'lifespan.db')))
    app=FastAPI(lifespan=lifespan)
    app.dependency_overrides[get_service]=lambda:service
    app.include_router(router)
    with TestClient(app):
        assert service.repository.db.path.exists()
        assert events==['start']
    assert events==['start','stop']
