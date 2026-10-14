import json
from fastapi.testclient import TestClient
from tests.test_baseline import sample
from src.train import run
from src.api import app as api_module


def test_trained_next_hour_and_auto_log(tmp_path, monkeypatch):
    (tmp_path / 'models').mkdir()
    (tmp_path / 'configs').mkdir()
    import shutil
    shutil.copy('configs/baseline.yaml', tmp_path / 'configs/baseline.yaml')
    csv = tmp_path / 'observations.csv'
    sample(1200).to_csv(csv, index=False)
    result = run(csv, tmp_path / 'configs/baseline.yaml', tmp_path / 'models/paper-inspired-v1.joblib')
    assert result['eligible_for_champion']
    monkeypatch.setattr(api_module, 'ROOT', tmp_path)
    monkeypatch.setenv('BUILDING_DATA_CSV', str(csv))
    # Registry is loaded once at startup, never by /health.
    api_module.refresh_health()
    client = TestClient(api_module.app)
    assert client.get('/health').json()['model_ready']
    start = '2026-02-20T00:00:00Z'
    end = '2026-02-20T01:00:00Z'
    req = dict(building_id='A', start=start, end=end)
    reply = client.post('/predict', json=req)
    assert reply.status_code == 200, reply.text
    data = reply.json()
    assert set(data) == {'building_id','model_version','alpha','predictions'}
    assert set(data['predictions'][0]) == {'timestamp','point','lower','upper','confidence','abstain','abstain_reason'}
    sched = client.post('/schedule', json=req)
    assert sched.status_code == 200, sched.text
    assert sched.json()['mode'] == 'auto'
    assert sched.json()['estimated_savings'] is None
    assert client.post('/explain', json=req).status_code == 200
    bad = client.post('/predict', json={**req,'start':'2026-02-20T01:00:00Z',
                                        'end':'2026-02-20T02:00:00Z'})
    assert bad.status_code == 422
