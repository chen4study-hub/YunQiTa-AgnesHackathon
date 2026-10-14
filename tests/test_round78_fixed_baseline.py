"""Baseline comparison is compatible, explicit and independently checkable."""
import copy
import hashlib
import json
import math
import subprocess
from pathlib import Path
import pytest
from scripts.compare_round78_fixed_baseline import fixed_candidate
from tests.test_planner_temperature_manual import inputs


def test_fixed_candidate_does_not_change_inputs_or_apply_temperature_optimizer():
    f,c,k=inputs();f['predictions'][12]['abstain']=True
    old=copy.deepcopy((f,c,k));candidate=fixed_candidate(f,c,k)
    assert old==(f,c,k)
    assert all(p['hvac_setpoint_c']==25.5 and p['action']!='precool' for p in candidate['plan'])
    assert candidate['plan'][12]['battery_kw']==0 and candidate['plan'][12]['action']=='human_review'
    assert 'temperature_optimization' not in candidate
    assert candidate['selection_reason']['policy']['id']=='upper_grid_peak_tolerance_then_cost_v2'


@pytest.mark.parametrize('scenario',['normal','peak','abstain'])
def test_saved_comparison_costs_independently_recomputed_same_accepted_scope(scenario):
    report=json.loads(Path('experiments/round78_fixed_baseline.json').read_text(encoding='utf-8'))
    data=json.loads(Path(f'exports/replay/{scenario}.json').read_text(encoding='utf-8'))
    cfg=json.loads(Path('configs/agent_tools.json').read_text(encoding='utf-8'))
    result=report['scenarios'][scenario]
    assert result['accepted_hours']==[i for i,r in enumerate(data['hours']) if not r['abstain']]
    assert result['excluded_hours']==[i for i,r in enumerate(data['hours']) if r['abstain']]
    costs={'fixed':0.,'new':0.};peaks={'fixed':[],'new':[]};soc={'fixed':.5,'new':.5}
    for i,(r,h) in enumerate(zip(data['hours'],result['hours'])):
        assert r['t']==h['timestamp'] and i==h['hour'] and h['included']==(not r['abstain'])
        tariff=cfg['tariff'];hour=i
        period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
        for name in ('fixed','new'):
            p=h[name+'_command'];assert math.isclose(soc[name],h[name+'_soc_before'],abs_tol=1e-7)
            soc[name]-=p['battery_kw']/cfg['equipment']['battery_capacity_kwh']
            assert .1<=soc[name]<=.95 and math.isclose(soc[name],h[name+'_soc_after'],abs_tol=1e-7)
            if r['abstain']:
                assert p['battery_kw']==0 and h[name+'_metrics']['energy_cost_cny'] is None
                continue
            model=cfg['linear_model'];factor=1-model['load_fraction_per_degree']*(p['hvac_setpoint_c']-model['baseline_setpoint_c'])+model['precool_extra_fraction']*(p['action']=='precool')
            grid=max(0.,r['point_kw']*max(0.,factor)-r['pv']['power_kw']-p['battery_kw'])
            costs[name]+=grid*tariff[period];peaks[name].append(grid)
        assert h['fixed_command']['hvac_setpoint_c']==25.5
        assert not h['occupied'] or h['new_max_zone_c']<=27
    for name in ('fixed','new'):
        assert math.isclose(costs[name],result[name+'_metrics']['energy_cost_cny'],abs_tol=1e-6)
        assert math.isclose(max(peaks[name]),result[name+'_metrics']['point_grid_peak_kw'],abs_tol=1e-6)
    assert math.isclose(costs['new']-costs['fixed'],result['new_minus_fixed_cny'],abs_tol=1e-6)
    assert report['new_dispatches']==report['new_llm_calls']==0 and report['source_files_unchanged']
    for path,digest in report['source_sha256'].items():
        # Report is frozen at 58c7142; later prose-only exports have new hashes.
        frozen=(subprocess.check_output(['git','show',report['source_main_commit']+':'+path.replace('\\','/')]) if path.replace('\\','/').startswith('exports/') else Path(path).read_bytes())
        assert hashlib.sha256(frozen).hexdigest()==digest
