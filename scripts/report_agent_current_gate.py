"""Frozen v3 aggregation and paired v2 comparison; never calls a provider."""
import json
from pathlib import Path
import pandas as pd
from scripts.report_agent13 import summarize
from scripts.report_agent24 import storage_metrics
PLAN=Path('experiments/agent_eval_v3_plan.json');HOURS=Path('experiments/agent_eval_v3_hours.jsonl');BINDING=Path('experiments/agent_eval_v3_binding.json')
from scripts.evaluate_agent13 import dates
from scripts.download_bdg2_thermal import sha


def main():
    rows=[json.loads(l) for l in HOURS.read_text(encoding='utf-8').splitlines()];plan=json.loads(PLAN.read_text())
    binding=json.loads(BINDING.read_text());assert sha(PLAN)==binding['plan_sha256']
    assert all(sha(p)==h for p,h in binding['code_sha256'].items()),'Frozen code changed'
    assert len(rows)==312 and len({(r['date'],r['hour']) for r in rows})==312
    old=[json.loads(l) for l in Path('experiments/agent_eval_v2_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    by_old={(r['date'],r['hour']):r for r in old};daily=[]
    for item in dates(plan):
        rs=sorted([r for r in rows if r['date']==item['date']],key=lambda r:r['hour']);assert [r['hour'] for r in rs]==list(range(24))
        d={**item,**summarize(rs),**storage_metrics(rs)};d['initial_soc']=.5;d['final_soc']=rs[-1]['soc_after'];daily.append(d)
    pooled={**summarize(rows),**storage_metrics(rows)}
    pooled['duplicate_display_metric_runs']=sum(len({tuple(round(a['objective_metrics'][k],1) if a['objective_metrics'][k] is not None else None for k in ('energy_cost_cny','upper_grid_peak_kw')) for a in r['result']['candidates']})!=len(r['result']['candidates']) for r in rows)
    pooled['accepted_current_provider_missed_hours']=sum(not r['current_refused'] and not r['provider_attempts'] for r in rows)
    pooled['cost_reduction_vs_hold25_pct']=100*pooled['cost_reduction_vs_hold25_cny']/pooled['hold25_cost_cny']
    pooled['upper_peak_reduction_vs_hold25_pct']=100*pooled['upper_peak_reduction_vs_hold25_kw']/pooled['hold25_upper_peak_kw']
    compare=dict(controls_changed_hours=sum(r['result']['plan']!=by_old[r['date'],r['hour']]['result']['plan'] for r in rows),
        first_control_changed_hours=sum(any(r['result']['plan'][0][k]!=by_old[r['date'],r['hour']]['result']['plan'][0][k] for k in ['hvac_setpoint_c','battery_kw','action']) for r in rows),
        input_changed_hours=sum(any(r[k]!=by_old[r['date'],r['hour']][k] for k in ['forecast','context','constraints']) for r in rows),
        economic_changed_hours=sum(r['economics']!=by_old[r['date'],r['hour']]['economics'] for r in rows),old_summary_sha256=sha('experiments/agent_eval_v2_summary.json'))
    base=summarize(old)
    compare['delta']={k:pooled[k]-base[k] for k in ['cost_cny','cost_reduction_cny','cost_reduction_vs_hold25_cny','upper_peak_kw','upper_peak_reduction_kw','upper_peak_reduction_vs_hold25_kw','validated_real_llm_hours','degraded_hours','provider_bypass_hours']}
    result=dict(status='completed',requested_llm_mode='real',policy=plan['selection_policy'],plan_sha256=sha(PLAN),binding_sha256=sha(BINDING),hours_sha256=sha(HOURS),
        economic_scope='accepted executed current steps only; no overlapping window double counting',dates_replaced=False,retuned=False,days=daily,summary=pooled,comparison_to_v2=compare)
    Path('experiments/agent_eval_v3_summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    pd.DataFrame([{k:v for k,v in d.items() if not isinstance(v,dict)} for d in daily]).to_csv('experiments/agent_eval_v3_days.csv',index=False)
    lines=['# 当前小时门控与候选结果去重：十三天真实复评','',
        '只修改当前门控适用范围和结果等价合并，预测/阈值/优化参数/目标/上下文不改。原十三天名单沿用、不换差结果，运行前冻结新plan/binding；原v2完整证据保留，不覆盖。','',
        '当前接受就调用LLM，未来拒绝只对应规划零充放电、理由逐项列小时，不触发当前转人工。当前拒绝跳过LLM，零功率转人工。未来工单保留为规划安全证据，接口needs_human只取当前。grounding与最优目标检查不放松。','',
        '候选按展示一位小数（电费、上界电网峰值）成对去重，保留每组原全精度上界峰/费用/候选名排序最优项，所以原全局最优仍在，不人为改控制，不挑更好收益。经济窗口仍二十四步，日汇总仅实际首步接受小时，拒绝不编费用。','',
        '## 每日真实来源（LLM通过 / 调用后回退 / 当前拒绝绕过）','',
        '|日期|LLM|调用后回退|当前拒绝绕过|回退原因|旧LLM/回退/绕过|','|---|---:|---:|---:|---|---|']
    for d in daily:
        previous=summarize([r for r in old if r['date']==d['date']])
        lines.append(f"|{d['date']}|{d['validated_real_llm_hours']}|{d['degraded_hours']}|{d['provider_bypass_hours']}|{json.dumps(d['degradation_reasons'],ensure_ascii=False)}|{previous['validated_real_llm_hours']}/{previous['degraded_hours']}/{previous['provider_bypass_hours']}|")
    def fmt(v):return '无' if v is None else f'{v:.2f}'
    lines+=['','## 每日两基准经济结果','',
        '|日期|24度基准费用|25.5度保持费用|规划费用|相对24度/25.5度费用差|上界峰24度/25.5度/规划 千瓦|',
        '|---|---:|---:|---:|---:|---:|']
    for d in daily:
        lines.append(f"|{d['date']}|{fmt(d['baseline_cost_cny'])}|{fmt(d['hold25_cost_cny'])}|{fmt(d['cost_cny'])}|{fmt(d['cost_reduction_cny'])}/{fmt(d['cost_reduction_vs_hold25_cny'])}|{fmt(d['baseline_upper_peak_kw'])}/{fmt(d['hold25_upper_peak_kw'])}/{fmt(d['upper_peak_kw'])}|")
    lines+=['','## 汇总与前后比较','',
        f"312小时，259接受/53当前拒绝。LLM验证{pooled['validated_real_llm_hours']}小时，调用后回退{pooled['degraded_hours']}，当前门控绕过{pooled['provider_bypass_hours']}；接受小时未调用provider={pooled['accepted_current_provider_missed_hours']}。provider成功传输{pooled['provider_transport_succeeded_calls']}/{pooled['provider_calls']}次，传输不等于最终校验通过。",
        f"相对24度基准：省{fmt(pooled['cost_reduction_cny'])}元/{fmt(pooled['cost_reduction_pct'])}%，最大上界峰下降{fmt(pooled['upper_peak_reduction_kw'])}千瓦/{fmt(pooled['upper_peak_reduction_pct'])}%。",
        f"相对25.5度保持：省{fmt(pooled['cost_reduction_vs_hold25_cny'])}元/{fmt(pooled['cost_reduction_vs_hold25_pct'])}%，最大上界峰下降{fmt(pooled['upper_peak_reduction_vs_hold25_kw'])}千瓦/{fmt(pooled['upper_peak_reduction_vs_hold25_pct'])}%。",
        f"与v2对比：输入变化{compare['input_changed_hours']}小时、首步控制变化{compare['first_control_changed_hours']}小时、逐小时经济变化{compare['economic_changed_hours']}小时；精确汇总差额{json.dumps(compare['delta'],ensure_ascii=False)}。不拿LLM来源增加冒充收益增加。",
        f"安全：约束违规{pooled['violating_runs']}、违规候选{pooled['violating_candidate_plans']}、重复展示指标{pooled['duplicate_display_metric_runs']}、非中文reason{pooled['non_chinese_reason_runs']}、最终无来源数字{pooled['explanation_unsourced_numeric_token_count']}；当前拒绝人工{pooled['current_refused_handoff_correct']}/{pooled['current_refused_hours']}；未来重叠拒绝安全{pooled['refused_steps_correct']}/{pooled['refused_steps_checked']}。",
        '', '## 限制与复现','',
        '保留v2的浮点峰优先敏感性，不改排序容差或储能参数。看板指标相同去重与排序容差是两件事；一位小数成对等价时保留原raw优胜项，因此不借去重改变政策最优。',
        '费用为未验证配置线性情景、单位储能效率、未计损耗/衰减/残余电量价值，非实测。拒绝小时排除非完整日账单；上界峰非联合路径覆盖保证。十三天已见样本，不是盲测或全年代表。与旧v2相同输入，同门控，同初始SOC和上下文，两组经济指标如有变化照实列出。',
        '日末电量/负收益不隐瞒：各日SOC详summary，部分拒绝日只充不放；相对25.5度有费用增加或日峰增加的日保留负数，不仅报总收益。',
        'python -m scripts.evaluate_agent24分段续未保存小时，失败小时不重跑。python -m scripts.report_agent_current_gate离线重算并配对v2。没有模型/阈值/参数/日期/提示测试集调优。新绑定锁住代码和输入，旧v2文件不改。',
        '密钥只原运行文件读取；产物无请求/响应正文/原始被拒草稿/密钥，日志仅安全状态。未改.env/配置、没有计划任务，未改twin/；常驻后端需用户重启。契约仍1.3，无新增对外字段。']
    Path('experiments/agent_eval_v3_report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(dict(summary=pooled,comparison=compare),indent=2))


if __name__=='__main__':main()
