from fastapi.testclient import TestClient
from src.api import app as api_module
from src.agent.scheduler import rule_plan
from src.agent.tools import check_constraints

client = TestClient(api_module.app)


def test_untrained_api_contract(tmp_path, monkeypatch):
    (tmp_path / 'models').mkdir()
    (tmp_path / 'models/registry.json').write_text('{"champion":null,"models":[]}', encoding='utf-8')
    monkeypatch.setattr(api_module, 'ROOT', tmp_path)
    # Health snapshots at startup; changing registry in a test needs a new lifespan.
    with TestClient(api_module.app) as started:health=started.get('/health').json()
    assert health['status']=='ok' and health['model_ready'] is False
    assert set(health)=={'status','model_ready','llm'}
    assert client.get('/models').json() == {'champion': None, 'models': []}
    req = {'building_id':'B001', 'start':'2026-10-09T12:00:00Z', 'end':'2026-10-09T13:00:00Z'}
    assert client.post('/predict', json=req).status_code == 503
    assert client.post('/schedule', json=req).status_code == 503
    assert client.post('/explain', json=req).status_code == 503
    assert client.post('/predict', json={**req, 'start':'2026-10-09T12:30:00Z',
                                      'end':'2026-10-09T13:30:00Z'}).status_code == 422


def test_safe_abstention_and_constraints():
    forecast = dict(building_id='A', model_version='mock', predictions=[
        dict(timestamp='2026-10-09T12:00:00Z', abstain=True,
             abstain_reason='routing_risk_above_threshold', point=100, lower=70, upper=130)])
    class Provider:
        def propose(self, *args):
            raise AssertionError('provider must not be called on abstain')
    plan = rule_plan(forecast, provider=Provider())
    assert plan['needs_human'] and plan['mode'] == 'auto'
    assert plan['estimated_savings'] is None
    assert plan['plan'][0]['action'] == 'human_review'
    safe = {**forecast, 'predictions': [{**forecast['predictions'][0],
            'abstain': False, 'abstain_reason': None}]}
    class BadProvider:
        def propose(self, *args):
            return {'plan': [dict(timestamp='2026-10-09T12:00:00Z',
                         hvac_setpoint_c=24, battery_kw=501, action='hold', reason='unsafe')]}
    assert rule_plan(safe, provider=BadProvider())['plan'][0]['battery_kw'] == 0
    assert check_constraints([{'hvac_setpoint_c': 30, 'battery_kw': 25}],
       dict(min_temp_c=22, max_temp_c=26, battery_max_kw=20,
            battery_capacity_kwh=80, initial_soc=.5, min_soc=.1, max_soc=.9))
