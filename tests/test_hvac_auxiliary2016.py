from src.data.replay_payload import load_replay
import hashlib
import json
from pathlib import Path
import numpy as np
import pytest
from src.data.hvac import ENGINEERING,ASSUMPTIONS,auxiliary_fraction


def test_fixed_engineering_formula_and_development_freeze():
    plan=json.loads(Path('experiments/hvac_auxiliary_v2_plan.json').read_text())
    dev=json.loads(Path('experiments/hvac_auxiliary_v2_development.json').read_text())
    assert plan['candidate_count']==1 and plan['no_2017_parameter_selection']
    assert ENGINEERING==plan['engineering_parameters'] and ASSUMPTIONS==dev['assumptions']
    assert dev['status']=='passed' and dev['year']==2016 and not dev['final_year_used_for_selection'] and not dev['parameters_retuned']
    assert dev['maximum_input_timestamp'].startswith('2016-12-31')
    assert hashlib.sha256(Path('experiments/hvac_auxiliary_v2_plan.json').read_bytes()).hexdigest()==dev['plan_sha256']
    assert hashlib.sha256(Path('src/data/hvac.py').read_bytes()).hexdigest()==dev['code_sha256']
    assert auxiliary_fraction('cooling')==pytest.approx(.04470201832676245)
    assert auxiliary_fraction('heating')==pytest.approx(.020642017845394618)
    assert ASSUMPTIONS['cooling_cop'] is None
    assert dev['summary']['n']==8663 and dev['summary']['cap_n']==0
    assert dev['summary']['pooled_uncapped_share']==pytest.approx(.29153896855855405)


def test_frozen2017proxy_no_current_clipping_and_honest_future_guard():
    for name in ['normal','peak','abstain']:
        d=load_replay(name);summary=d['energy_summary']
        assert summary['valid_hours']==24 and summary['cap_applied_hours']==0
        assert all(not h['hvac']['cap_applied'] for h in d['hours'])
        assert 0<summary['hvac_electric_estimated_share']<.6
        # The safety guard stays in place on future path; not tuned away on2017.
        for origin in d['hours']:
            for p in origin['forecast_24h']:
                assert p['hvac_electric_estimate_kw']<=p['point_kw']
                assert p['hvac']['effective_readings']==origin['hvac']['effective_readings']
                assert p['hvac']['origin']==origin['t']
