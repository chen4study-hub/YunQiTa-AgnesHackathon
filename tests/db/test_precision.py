"""Display rounding does not leak into repository storage or control validation."""
import copy
import hashlib
import json
from datetime import datetime
import pytest
from fastapi.testclient import TestClient
from src.db.evidence import ExportEvidence, canonical
from src.db.precision import display_precision
from src.db.standalone import create_app
from src.api.takeover_router import get_service
from test_takeover_api import payload

TAIL = 199.9999000175467
SOC = 0.678912345678


@pytest.mark.parametrize('status',['executed','handoff'])
def test_recommendation_precision_and_hash_submission(tmp_path,status):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-12',10)
    command=dict(timestamp=row['t'],hvac_setpoint_c=25.499999999,battery_kw=TAIL,
                 storage_mode='discharge',remaining_duration_hours=1,reason='核对后调整储能')
    row['storage']['soc']=SOC
    row['agent'].update(status=status,selected='test',explanation='核对后调整储能',
                        candidates=[dict(candidate_id='test',plan=[command])],manual_reference=[command])
    original=copy.deepcopy(row)
    evidence.hour=lambda *args:(copy.deepcopy(row),source)
    app=create_app(tmp_path/'precision.db',evidence=evidence)
    with TestClient(app) as client:
        response=client.get('/takeover/recommendation?date=2026-10-12&hour=10')
        rec=response.json()
        assert rec['available']
        assert rec['battery_kw']==200.0 and rec['storage_power_kw']==200.0
        assert rec['hvac_setpoint_c']==25.5
        assert '199.9999000175467' not in response.text
        hashed={k:v for k,v in rec.items() if k not in ('api_version','recommendation_hash')}
        assert rec['recommendation_hash']==hashlib.sha256(canonical(hashed).encode()).hexdigest()
        assert client.get('/takeover/recommendation?date=2026-10-12&hour=10').json()==rec
        data=payload(recommendation_hash=rec['recommendation_hash'])
        data.update(storage_mode='discharge',storage_power_kw=TAIL,hvac_setpoint_c=25.499999999,duration_hours=1)
        result=client.post('/takeover',json=data)
        assert result.status_code==200,result.text
        assert result.json()['takeover']['storage_power_kw']==200.0
        service=app.dependency_overrides[get_service]()
        with service.repository.db.transaction() as conn:
            stored=conn.execute('SELECT storage_power_kw,hvac_setpoint_c FROM takeovers').fetchone()
            assert stored['storage_power_kw']==TAIL
            assert stored['hvac_setpoint_c']==25.499999999
        # Values that would round into allowed bounds must still fail validation.
        bad={**data,'storage_power_kw':500.04}
        assert client.post('/takeover',json=bad).status_code==422
    assert row==original


def test_agent_receipt_recursive_precision_no_mutation(tmp_path):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-12',10)
    receipt=dict(count=2,elapsed_ms=1.234567,transport='log_only',device_connected=False,
                 battery_kw=TAIL,energy_kwh=TAIL,hvac_setpoint_c=25.499999999,
                 soc=SOC,storage_soc=SOC,reference_soc_before=SOC,load_share=SOC,
                 nested=[dict(power_kw=TAIL,energy_kwh=TAIL,ratio=SOC)])
    row['agent']['receipt']=receipt
    original=copy.deepcopy(row)
    evidence.hour=lambda *args:(row,source)
    with TestClient(create_app(tmp_path/'receipt.db',evidence=evidence)) as client:
        result=client.get('/dispatch/receipt?date=2026-10-12&hour=10&operator_id=reader')
        assert result.status_code==200,result.text
        displayed=result.json()['receipt']
        assert displayed['battery_kw']==200.0 and displayed['energy_kwh']==200.0
        assert displayed['hvac_setpoint_c']==25.5
        for field in ('soc','storage_soc','reference_soc_before','load_share'):
            assert displayed[field]==0.6789
        assert displayed['nested']==[dict(power_kw=200.0,energy_kwh=200.0,ratio=0.6789)]
        assert displayed['elapsed_ms']==1.234567 and displayed['count']==2
    assert row==original


def test_database_receipt_precision_keeps_original_values(tmp_path):
    app=create_app(tmp_path/'database-receipt.db')
    with TestClient(app) as client:
        repository=app.dependency_overrides[get_service]().repository
        receipt=dict(count=2,transport='log_only',device_connected=False,
                     energy_kwh=TAIL,soc=SOC,storage_share=SOC)
        commands=[dict(destination='BA',command=dict(setpoint_c=25.499999999)),
                  dict(destination='EMS',command=dict(battery_kw=TAIL))]
        repository.record_agent_dispatch('2026-10-12',10,'test',commands,receipt,'precision')
        response=client.get('/dispatch/receipt?date=2026-10-12&hour=10&operator_id=reader')
        assert response.status_code==200,response.text
        records=response.json()['records']
        assert next(r['command'] for r in records if r['destination']=='EMS')['battery_kw']==200.0
        assert next(r['command'] for r in records if r['destination']=='BA')['setpoint_c']==25.5
        assert all(r['receipt']['energy_kwh']==200.0 and r['receipt']['soc']==0.6789 for r in records)
        raw=repository.receipts('2026-10-12',10)
        assert next(r['command'] for r in raw if r['destination']=='EMS')['battery_kw']==TAIL
        assert raw[0]['receipt']['soc']==SOC and raw[0]['receipt']['energy_kwh']==TAIL


def test_soc_validation_remains_full_precision(tmp_path):
    evidence=ExportEvidence()
    row,source=evidence.hour('2026-10-12',10)
    row['storage']['soc']=0.09999999
    evidence.hour=lambda *args:(row,source)
    with TestClient(create_app(tmp_path/'soc.db',evidence=evidence)) as client:
        data=payload();data.update(storage_mode='discharge',storage_power_kw=0.1)
        assert client.post('/takeover',json=data).status_code==422


def test_precision_preserves_metadata_and_normalizes_negative_zero():
    raw=dict(id=123456789,hour=10,duration_hours=2,start_ms=1791770400000,
             device_connected=False,battery_kw=-0.0000001,soc=0.12345678,
             value=TAIL,label='199.9999000175467',fraction=0.12345678)
    displayed=display_precision(raw)
    assert displayed['battery_kw']==0.0 and '-0.0' not in json.dumps(displayed)
    assert displayed['soc']==0.1235 and displayed['fraction']==0.1235
    for key in ('id','hour','duration_hours','start_ms','device_connected','value','label'):
        assert displayed[key]==raw[key]
    assert raw['battery_kw']==-0.0000001
