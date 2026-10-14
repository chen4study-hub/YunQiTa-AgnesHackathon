"""Attach quantitative audit to historical controls, never rewrite dispatched records/LLM provenance."""
import json
from pathlib import Path
from datetime import datetime,timedelta
import joblib
import pandas as pd
from src.agent.orchestrator import schedule_candidate,check_grounding,candidate_evidence
from src.agent.selection import evaluate_candidates
from src.agent.tools import tool_config,check_constraints,simulate_schedule
from scripts.export_replay import pv_sim


def attach_selection_audit():
    for name in ['normal','peak','abstain']:
        current=json.loads(Path(f'exports/replay/{name}.json').read_text(encoding='utf-8'))
        if any('selected' in h['agent'] for h in current['hours']):
            raise ValueError('Live-objective refreshed records cannot be overwritten with historical audit')
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text());weather=pd.read_csv('data/byron2017.csv')
    weather['wall']=pd.to_datetime(weather.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');weather=weather.set_index('wall')
    records=[]
    for scenario in ['normal','peak','abstain']:
        path=Path(f'exports/replay/{scenario}.json');data=json.loads(path.read_text(encoding='utf-8'));soc=.5
        for row in data['hours']:
            origin=datetime.fromisoformat(row['t']);item=next(i for i in index['rows'] if i['month']==origin.strftime('%Y-%m'))
            bundle=joblib.load(item['artifact']);cache=pd.read_csv(item['predictions'])
            cache['wall']=pd.to_datetime(cache.timestamp,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S');cache=cache.set_index('wall')
            predictions=[];context=[];config=tool_config();tariff=config['tariff']
            for step in [0,1]:
                t=origin+timedelta(hours=step);wall=t.strftime('%Y-%m-%d %H:%M:%S');p=cache.loc[wall];w=weather.loc[wall]
                predictions.append(dict(timestamp=t.isoformat(),point=float(p.point),upper=float(p.upper),lower=float(p.lower),abstain=bool(p.abstain)))
                period='valley' if t.hour in tariff['valley_hours'] else 'peak' if t.hour in tariff['peak_hours'] else 'flat'
                context.append(dict(timestamp=t.isoformat(),tariff_period=period,price_per_kwh=tariff[period],pv_kw=pv_sim(t.hour,float(w.cloud_coverage)),outdoor_temp_c=float(w.air_temperature)))
            limits={**config['equipment'],'initial_soc':soc,'peak_target_kw':bundle['peak_load_threshold']}
            f=dict(predictions=predictions);ctx=dict(hours=context);candidates=[]
            for name,scale in [('rule_full',1.),('rule_conservative',.5),('rule_hold',0.)]:
                c=schedule_candidate(f,ctx,limits,name,scale)
                if name=='rule_hold':
                    for p in c['plan']:p.update(hvac_setpoint_c=25.5,battery_kw=0.,action='human_review' if p['action']=='human_review' else 'hold')
                if check_constraints(c['plan'],limits):continue
                accepted=[i for i,p in enumerate(predictions) if not p['abstain']]
                c['simulation']=simulate_schedule([c['plan'][i] for i in accepted],{'predictions':[predictions[i] for i in accepted]},limits,{'hours':[context[i] for i in accepted]}) if accepted else {'estimated_cost':None}
                candidates.append(c)
            preferred=evaluate_candidates(candidates,f,ctx,limits)
            matches=[c for c in candidates if abs(c['plan'][0]['battery_kw']-row['storage']['power_kw'])<1e-6 and abs(c['plan'][0]['hvac_setpoint_c']-row['agent']['hvac_setpoint_c'])<1e-6]
            if row['abstain']:
                review=dict(policy={'id':'historical_handoff'},selected_candidate_id=None,preferred_candidate_id=preferred['candidate_id'],objective_optimal=None,
                    summary='低置信度，转交人工；未执行该小时调度。')
            else:
                selected=matches[0] if len(matches)==1 else None
                # Identical first controls do not reveal which two-step plan LLM chose.
                review=dict(selected['selection_reason']) if selected else dict(policy={'id':'historical_selection_not_recoverable'},
                    selected_candidate_id=None,preferred_candidate_id=preferred['candidate_id'],objective_optimal=None,
                    metrics={c['candidate_id']:c['selection_reason']['metrics'][c['candidate_id']] for c in candidates},
                    summary='历史候选选择记录不完整，不能从当前小时指令确认完整方案；新请求按区间上界峰值优先、同峰比较电费。')
                if selected and not review['objective_optimal']:
                    review['policy']={**review['policy'],'applied_to_historical_choice':False}
                    review['summary']='历史选择不符合新的峰值优先目标；保留已执行记录，不追认旧选择理由。'
            # Separate same-hour comparison matches frontend cost formula, no unseen precool benefit.
            if not row['abstain']:
                single=[];raw_costs=[];raw_peaks=[]
                for name,temp,power in [('historical_full',row['agent']['hvac_setpoint_c'],row['storage']['power_kw']),('conservative',25.5,row['storage']['power_kw']*.5),('baseline',24.,0.)]:
                    factor=max(0.,1-.03*(temp-24.));h=context[0]
                    plan=[dict(timestamp=row['t'],hvac_setpoint_c=temp,battery_kw=power,action='hold')]
                    raw_costs.append(max(0.,row['point_kw']*factor-h['pv_kw']-power)*h['price_per_kwh'])
                    raw_peaks.append(max(0.,row['upper_kw']*factor-h['pv_kw']-power))
                    single.append(dict(candidate_id=name,energy_cost_cny=round(max(0.,row['point_kw']*factor-h['pv_kw']-power)*h['price_per_kwh'],1),
                        upper_grid_peak_kw=round(max(0.,row['upper_kw']*factor-h['pv_kw']-power),1),hvac_setpoint_c=temp,battery_kw=power,constraint_valid=not check_constraints(plan,limits)))
                first,second=single[:2]
                extra=round(raw_costs[0]-raw_costs[1],1);peak_gain=round(raw_peaks[1]-raw_peaks[0],1)
                review['current_hour_comparison']=dict(candidates=single,additional_cost_vs_conservative_cny=extra,upper_peak_reduction_vs_conservative_kw=peak_gain,
                    scope='one-hour frontend point-load formula; no stored precool benefit; previousSOC constraints; not full2hchosenplan')
                if extra>0 and peak_gain<=0 and second['constraint_valid']:
                    review['summary']=f"历史单小时选择缺乏数值依据：电费 {first['energy_cost_cny']:.1f} 元高于保守方案 {second['energy_cost_cny']:.1f} 元，多花 {extra:.1f} 元，却未压低区间上界峰值。旧下发记录保留；新请求按可核验目标选优。"
                    review['current_hour_comparison']['historical_choice_dominated']=True
            review.update(audit=True,origin=row['t'],horizon_hours=2,current_only_dispatch=True,legacy_lookahead=True)
            if not check_grounding(review['summary'],review):raise ValueError('Audit grounding failed')
            row['agent']['selection_reason']=review;soc-=row['storage']['power_kw']/2000
            records.append(dict(scenario=scenario,origin=row['t'],selected=review['selected_candidate_id'],preferred=review['preferred_candidate_id'],objective_optimal=review['objective_optimal']))
        path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf-8')
    Path('experiments/agent_selection_audit.json').write_text(json.dumps(dict(records=records,new_llm_calls=0,legacy_controls_preserved=True),indent=2),encoding='utf-8')


if __name__=='__main__':attach_selection_audit()
