"""Fixed 25.5 C with original rolling storage rules; no control writes or LLM."""
import copy
import hashlib
import json
import os
from pathlib import Path

from src.agent.rolling_context import from_replay
from src.agent.storage_planner import rolling_candidate
from src.agent.selection import evaluate_candidates
from src.agent.temperature_planner import control_metrics
from src.agent.tools import check_constraints
from src.agent.zone_comfort import maximum_zone_temperature, occupied
from src.data.replay_payload import load_replay

ROOT=Path('exports/replay')
OUT=Path('experiments/round78_fixed_baseline.json')


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fixed_candidate(forecast,context,limits):
    # The existing rule_full/conservative/hold LP and policy, WITHOUT thermal
    # optimization, precooling or new comfort clamp. Fixed means exactly 25.5 C.
    candidates=[]
    for name,scale in [('rule_full',1.),('rule_conservative',.5),('rule_hold',0.)]:
        c=rolling_candidate(forecast,context,limits,name,scale)
        assert all(p['hvac_setpoint_c']==25.5 for p in c['plan'])
        assert not check_constraints(c['plan'],limits)
        m=control_metrics(c['plan'],forecast['predictions'],context['hours'])
        c['simulation']=dict(estimated_cost=m['energy_cost_cny'],estimated_peak_kw=m['point_grid_peak_kw'])
        candidates.append(c)
    return evaluate_candidates(candidates,forecast,context,limits)


def compare(data):
    before_soc=after_soc=.5;rows=[];predictions=[];contexts=[];before=[];after=[]
    for i,row in enumerate(data['hours']):
        forecast,context,limits=from_replay(data,row,before_soc)
        baseline=fixed_candidate(forecast,context,limits);b=baseline['plan'][0]
        selected=next(c for c in row['agent']['candidates'] if c['candidate_id']==row['agent']['selected'])
        a=next(p for p in selected['plan'] if p['timestamp']==row['t'])
        assert a['timestamp']==b['timestamp']==forecast['predictions'][0]['timestamp']
        assert abs(a['battery_kw']-row['storage']['power_kw'])<1e-7
        assert not check_constraints([b],{**limits,'initial_soc':before_soc})
        assert not check_constraints([a],{**limits,'initial_soc':after_soc})
        if row['abstain']:assert a['battery_kw']==b['battery_kw']==0
        start_b=before_soc;start_a=after_soc
        before_soc-=b['battery_kw']/limits['battery_capacity_kwh']
        after_soc-=a['battery_kw']/limits['battery_capacity_kwh']
        assert abs(after_soc-row['storage']['soc'])<1e-7
        pred=forecast['predictions'][0];hour=context['hours'][0]
        bm=control_metrics([b],[pred],[hour]);am=control_metrics([a],[pred],[hour])
        bz=maximum_zone_temperature(pred,hour,25.5)
        az=maximum_zone_temperature(pred,hour,a['hvac_setpoint_c'])
        if occupied(pred):assert az<=27
        rows.append(dict(hour=i,timestamp=row['t'],included=not row['abstain'],
            fixed_candidate_id=baseline['candidate_id'],new_candidate_id=selected['candidate_id'],
            fixed_command=copy.deepcopy(b),new_command=copy.deepcopy(a),fixed_metrics=bm,new_metrics=am,
            fixed_soc_before=start_b,fixed_soc_after=before_soc,new_soc_before=start_a,new_soc_after=after_soc,
            fixed_max_zone_c=bz,new_max_zone_c=az,occupied=occupied(pred)))
        predictions.append(pred);contexts.append(hour);before.append(b);after.append(a)
    bm=control_metrics(before,predictions,contexts);am=control_metrics(after,predictions,contexts)
    extra=am['energy_cost_cny']-bm['energy_cost_cny'] if bm['energy_cost_cny'] is not None else None
    # Diagnostic isolation: fixed temperature with NEW executed storage, not the
    # primary baseline. Explicitly label it so storage reselection is not hidden.
    same_power=[{**p,'hvac_setpoint_c':25.5,'action':'human_review' if r['abstain'] else 'dispatch' if p['battery_kw'] else 'hold'} for p,r in zip(after,predictions)]
    matched=control_metrics(same_power,predictions,contexts)
    return dict(accepted_hours=[r['hour'] for r in rows if r['included']],excluded_hours=[r['hour'] for r in rows if not r['included']],
        fixed_metrics=bm,new_metrics=am,new_minus_fixed_cny=extra,savings_cny=-extra if extra is not None else None,
        new_minus_fixed_percent=100*extra/bm['energy_cost_cny'] if extra is not None and bm['energy_cost_cny'] else None,
        fixed_initial_soc=.5,fixed_final_soc=before_soc,new_initial_soc=.5,new_final_soc=after_soc,
        fixed_occupied_over_27_hours=[r['hour'] for r in rows if r['occupied'] and r['fixed_max_zone_c']>27],
        new_occupied_over_27_hours=[r['hour'] for r in rows if r['occupied'] and r['new_max_zone_c']>27],
        temperature_only_diagnostic=dict(scope='fixed25.5 but NEW executed storage powers, not original-rule baseline',fixed_metrics=matched,
            new_minus_fixed_cny=am['energy_cost_cny']-matched['energy_cost_cny'] if matched['energy_cost_cny'] is not None else None),hours=rows)


def run():
    source_paths=[str(ROOT/(n+s)) for n in ('normal','peak','abstain') for s in ('.json','.agent-detail.json')]
    source_paths+=['configs/agent_tools.json','src/agent/storage_planner.py','src/agent/selection.py','src/agent/temperature_planner.py']
    hashes={p:digest(p) for p in source_paths}
    result={n:compare(load_replay(n)) for n in ('normal','peak','abstain')}
    assert hashes=={p:digest(p) for p in source_paths}
    out=dict(status='passed',source_main_commit='58c7142',source_sha256=hashes,
        baseline='25.5 C every hour; original storage_planner rolling_candidate full/half/hold (500/250/0 kW), selection.policy unchanged; independent propagated SOC from 0.5',
        clock='current one-step + origin-issued h1..h23, current known PV and tariff, future zero PV; no future observations',
        scope='sum only 24 daily first-step executions that current daily10 permits, identical accepted hours; not sum of overlapping rolling windows',
        limitations=['configured linear response and tariff, not measured site-billing savings',
            'fixed25.5 is an unconstrained counterfactual and may exceed the 27C zone limit; never recommended for dispatch',
            'terminal SOC constrained in each rolling window, not forced equal at day-end; final SOC reported, no invented settlement credit',
            'manual/refused hours excluded completely from both costs; no whole-day realized savings claim'],
        new_llm_calls=0,new_dispatches=0,source_files_unchanged=True,scenarios=result)
    OUT.write_text(json.dumps(out,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps({n:{k:v for k,v in s.items() if k not in ('hours','temperature_only_diagnostic')} for n,s in result.items()},ensure_ascii=False))


if __name__=='__main__':
    for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):os.environ[key]='1'
    run()
