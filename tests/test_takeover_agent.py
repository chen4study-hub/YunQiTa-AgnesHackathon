import copy
import pytest
from src.db import Database,Repository
from src.agent.orchestrator import run_agent
from tests.test_agent_orchestrator import fixtures


@pytest.fixture
def repo(tmp_path,monkeypatch):
    path=tmp_path/'takeover.db';monkeypatch.setenv('YUNQI_DB_PATH',str(path))
    db=Database(path);db.migrate();return Repository(db)


def record(repo,hour=6):
    return repo.create(dict(date='2026-10-12',hour=hour,duration_hours=1,operator_id='值班员甲',
        hvac_setpoint_c=26.0,storage_mode='charge',storage_power_kw=50.,reason='检查设备后调整'),{'building_id':'A'})


class NoLLM:
    def choose_candidate(self,*args):pytest.fail('manual hour must not call selection LLM')


def test_manual_controls_no_dispatch_preserve_forecast(repo,tmp_path):
    record(repo);f,c=fixtures();original=copy.deepcopy(f);path=tmp_path/'dispatch.jsonl'
    r=run_agent(f,c,provider=NoLLM(),dispatch_path=path,dispatch_current_only=True,takeover_date='2026-10-12')
    assert r['status']=='manual' and r['source']=='manual'
    assert r['plan'][0]['hvac_setpoint_c']==26 and r['plan'][0]['battery_kw']==-50
    assert r['plan'][0]['action']=='manual' and r['receipt']['count']==0
    assert not path.exists() and f==original
    assert r['active_takeover']['operator_id']=='值班员甲'


def test_final_lookup_suppresses_takeover_created_during_selection(repo,tmp_path):
    f,c=fixtures();path=tmp_path/'dispatch.jsonl'
    class DuringSelection:
        def choose_candidate(self,*args):
            record(repo)
            return {'choice':{},'llm':{'mode':'rule','reason':'key_unavailable'}}
    r=run_agent(f,c,provider=DuringSelection(),dispatch_path=path,dispatch_current_only=True,takeover_date='2026-10-12')
    assert r['status']=='manual' and not path.exists()


def test_future_manual_filtered_from_dispatch_and_cancel_boundary(repo,tmp_path,monkeypatch):
    record(repo,7);monkeypatch.setenv('LLM_MODE','demo');f,c=fixtures();path=tmp_path/'d.jsonl'
    r=run_agent(f,c,dispatch_path=path,takeover_date='2026-10-12')
    assert r['status']=='executed' and r['receipt']['count']==4
    assert f['predictions'][1]['timestamp'] not in path.read_text()
    assert r['plan'][1]['action']=='manual'


def test_schedule_api_passes_date_and_marks_manual(repo,monkeypatch,tmp_path):
    from fastapi.testclient import TestClient
    from src.api import app as api
    record(repo);f,c=fixtures();f['model_version']='test'
    for hour in c['hours']:hour['storage_soc']=.5
    monkeypatch.setattr(api,'forecast',lambda *a:f)
    monkeypatch.setattr(api,'get_context',lambda *a:c)
    monkeypatch.setattr(api,'ROOT',tmp_path)
    with TestClient(api.app) as client:
        r=client.post('/schedule',json=dict(building_id='A',start=f['predictions'][0]['timestamp'],
            end=f['predictions'][1]['timestamp'],display_date='2026-10-12'))
    assert r.status_code==200,r.text
    out=r.json();assert out['status']=='manual' and out['mode']=='manual'
    assert not out['dispatch_enabled'] and out['receipt']['count']==0
    assert out['estimated_cost'] is None and not (tmp_path/'logs/dispatch.jsonl').exists()
