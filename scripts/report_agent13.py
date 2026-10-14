"""Recompute every day metric from executed first-step records, no overlapping-window sums."""
from collections import Counter
import json
from pathlib import Path
import pandas as pd
from scripts.download_bdg2_thermal import sha
from scripts.evaluate_agent13 import HOURS,PLAN,BINDING,dates

SUMMARY=Path('experiments/agent_eval_v1_summary.json');REPORT=Path('experiments/agent_eval_v1_report.md')


def summarize(rows):
    rows=sorted(rows,key=lambda r:(r['date'],r['hour']));accepted=[r for r in rows if not r['current_refused']];refused=[r for r in rows if r['current_refused']]
    code=Counter(c for r in rows for c in set(r['constraint_codes']+r['current_constraint_codes']))
    sources=Counter(r['result']['source'] for r in rows);modes=Counter(r['result']['llm']['mode'] for r in rows)
    fallback=Counter(r['result']['llm'].get('reason','unknown') for r in rows if r['result']['source']=='rule' and r['provider_attempts'])
    bypass=Counter(r['result']['llm'].get('reason','unknown') for r in rows if not r['provider_attempts'])
    attempts=[a for r in rows for a in r['provider_attempts']]
    cost=sum(r['economics']['cost'] for r in accepted);baseline=sum(r['economics']['baseline_cost'] for r in accepted);hold=sum(r['economics']['hold25_cost'] for r in accepted)
    peak=max((r['economics']['upper_peak'] for r in accepted),default=None);basepeak=max((r['economics']['baseline_upper_peak'] for r in accepted),default=None);holdpeak=max((r['economics']['hold25_upper_peak'] for r in accepted),default=None)
    steps=[p for r in rows for p in r['refused_steps']];handoff=sum(r['current_handoff_correct'] for r in refused)
    socs=[r['soc_before'] for r in rows]+[r['soc_after'] for r in rows]
    return dict(hours=len(rows),accepted_hours=len(accepted),current_refused_hours=len(refused),cost_cny=cost if accepted else None,baseline_cost_cny=baseline if accepted else None,
        cost_reduction_cny=baseline-cost if accepted else None,cost_reduction_pct=100*(baseline-cost)/baseline if baseline else None,
        hold25_cost_cny=hold if accepted else None,cost_reduction_vs_hold25_cny=hold-cost if accepted else None,
        upper_peak_kw=peak,baseline_upper_peak_kw=basepeak,upper_peak_reduction_kw=basepeak-peak if basepeak is not None else None,
        upper_peak_reduction_pct=100*(basepeak-peak)/basepeak if basepeak else None,hold25_upper_peak_kw=holdpeak,upper_peak_reduction_vs_hold25_kw=holdpeak-peak if holdpeak is not None else None,
        violating_runs=sum(bool(r['constraint_codes'] or r['current_constraint_codes']) for r in rows),constraint_violation_codes=dict(code),
        violating_candidate_plans=sum(bool(v) for r in rows for v in r['candidate_constraint_codes'].values()),
        current_refused_handoff_correct=handoff,current_refused_handoff_fraction=handoff/len(refused) if refused else None,
        refused_steps_checked=len(steps),refused_steps_correct=sum(p['correct'] for p in steps),
        explanation_unsourced_numeric_token_count=sum(r['explanation_unsourced_numeric_token_count'] for r in rows),
        rejected_provider_unsourced_numeric_token_count=sum(a['unsourced_numeric_token_count'] for a in attempts),
        source_hours=dict(sources),returned_llm_mode_hours=dict(modes),provider_attempted_hours=sum(bool(r['provider_attempts']) for r in rows),
        provider_calls=len(attempts),provider_transport_succeeded_calls=sum(a['mode']=='real' and a['reason']=='call_succeeded' for a in attempts),
        validated_real_llm_hours=sources.get('llm',0),degraded_hours=sum(fallback.values()),degradation_reasons=dict(fallback),provider_bypass_hours=sum(bypass.values()),provider_bypass_reasons=dict(bypass),
        soc_min=min(socs) if socs else None,soc_max=max(socs) if socs else None,comfort_degree_hours=sum(r['economics']['comfort_degree_hours'] for r in accepted),
        dispatched_current_commands=sum(r['result']['receipt']['count'] for r in rows))


def main():
    rows=[json.loads(line) for line in HOURS.read_text(encoding='utf-8').splitlines()];plan=json.loads(PLAN.read_text());selected=dates(plan)
    if len(rows)!=312:raise ValueError('Need all312hours; never publish partial as completed')
    daily=[]
    for item in selected:
        r=[r for r in rows if r['date']==item['date']]
        if sorted(x['hour'] for x in r)!=list(range(24)):raise ValueError('Missing/duplicate day hour')
        d=pd.Timestamp(item['date']);m=d.month;season='winter' if m in [12,1,2] else 'spring' if m in [3,4,5] else 'summer' if m in [6,7,8] else 'autumn'
        daily.append(dict(**item,weekday=d.day_name(),weekend=d.dayofweek>=5,season=season,holiday=item['date'] in ['2017-07-04','2017-11-23'],initial_soc=.5,final_soc=sorted(r,key=lambda r:r['hour'])[-1]['soc_after'],**summarize(r)))
    pooled=summarize(rows)
    pooled['daily_upper_peak_reduction_kw_sum']=sum(d['upper_peak_reduction_kw'] for d in daily)
    pooled['daily_upper_peak_reduction_pct_mean']=sum(d['upper_peak_reduction_pct'] for d in daily)/len(daily)
    result=dict(status='completed',requested_llm_mode='real',policy=plan['selection_policy'],plan_sha256=sha(PLAN),binding_sha256=sha(BINDING),hours_sha256=sha(HOURS),
        economic_scope='accepted current steps only, no overlapping next-step costs; configured unvalidatedlinear economics',days=daily,summary=pooled,dates_replaced=False,retuned=False)
    SUMMARY.write_text(json.dumps(result,indent=2),encoding='utf-8');pd.DataFrame(daily).drop(columns=['constraint_violation_codes','source_hours','returned_llm_mode_hours','degradation_reasons','provider_bypass_reasons']).to_csv('experiments/agent_eval_v1_days.csv',index=False)
    lines=['# Agent13天真实配置评测','',
        '## 挑日与协议','',
        '计划先冻结：3典型日（此前已看过，并非随机）；另10天仅按日历：1/4/7/10月首周三+首周六，2月首周三，11月第四周四感恩节。覆盖四季、工作日/周末及节假日，不按负荷/门控/收益筛选，不替换差结果。详agent_eval_v1_plan.json及binding.json。','',
        '每小时新run_agent，current+next历史一步缓存/天气上下文，同现有演示。每个日初SOC=0.5，串行传播当小时指令、只当前指令下发日志；next重复预测不重复计费，不借生产/导出checkpoint。日间独立并发，LLM真实配置，不因失败重跑。模型/阈值不改，无2017调参。','',
        '## 按天结果','',
        '费用/峰值：只比较该日当前预测门控通过小时，与24°C、零储能不调度基准（同PV/电价）。拒绝小时不编费用，因此不是完整日账单或完整日峰值。降幅负数如实保留。','',
        '|日期|组/季节|周末/节日|有效/拒绝小时|电费 基准→Agent 元|下降元/%|上界峰值 基准→Agent kW|下降kW/%|LLM/降级/绕过|违规/无来源数|转人工率|末SOC|',
        '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    def fmt(x):return 'N/A' if x is None else f'{x:.2f}'
    for d in daily:
        human='N/A' if d['current_refused_handoff_fraction'] is None else f"{d['current_refused_handoff_fraction']*100:.0f}%"
        lines.append(f"|{d['date']}|{d['group']}/{d['season']}|{d['weekend']}/{d['holiday']}|{d['accepted_hours']}/{d['current_refused_hours']}|{fmt(d['baseline_cost_cny'])}→{fmt(d['cost_cny'])}|{fmt(d['cost_reduction_cny'])}/{fmt(d['cost_reduction_pct'])}|{fmt(d['baseline_upper_peak_kw'])}→{fmt(d['upper_peak_kw'])}|{fmt(d['upper_peak_reduction_kw'])}/{fmt(d['upper_peak_reduction_pct'])}|{d['validated_real_llm_hours']}/{d['degraded_hours']}/{d['provider_bypass_hours']}|{d['violating_runs']}/{d['explanation_unsourced_numeric_token_count']}|{human}|{d['final_soc']:.3f}|")
    lines+=['','## 汇总','',f"312小时，其中有效{pooled['accepted_hours']}、当前拒绝{pooled['current_refused_hours']}。",f"配对总费用{fmt(pooled['baseline_cost_cny'])}→{fmt(pooled['cost_cny'])}元，下降{fmt(pooled['cost_reduction_cny'])}元/{fmt(pooled['cost_reduction_pct'])}%。",f"跨所选日有效小时最大上界峰值{fmt(pooled['baseline_upper_peak_kw'])}→{fmt(pooled['upper_peak_kw'])}kW，差{fmt(pooled['upper_peak_reduction_kw'])}kW/{fmt(pooled['upper_peak_reduction_pct'])}%；不是逐日百分比的总和。逐日上界峰值下降百分比平均{fmt(pooled['daily_upper_peak_reduction_pct_mean'])}%。",f"真实LLM验证成功{pooled['validated_real_llm_hours']}小时；provider尝试{pooled['provider_attempted_hours']}小时/{pooled['provider_calls']}调用，其中传输成功响应{pooled['provider_transport_succeeded_calls']}次（不等于通过grounding/目标的小时数）。",f"降级{pooled['degraded_hours']}小时，门控绕过{pooled['provider_bypass_hours']}小时。",f"违规运行{pooled['violating_runs']}、违规候选{pooled['violating_candidate_plans']}；最终解释无来源数字{pooled['explanation_unsourced_numeric_token_count']}个。被拒provider草稿中无来源数字诊断{pooled['rejected_provider_unsourced_numeric_token_count']}个，不将其输出为最终解释、不保存原文。",f"当前拒绝转人工{pooled['current_refused_handoff_correct']}/{pooled['current_refused_hours']}；全部窗口拒绝步骤检查{pooled['refused_steps_correct']}/{pooled['refused_steps_checked']}（重叠next仅做安全检查）。",'','## 降级原因逐日','', '|日期|调用/校验降级原因|未调用provider原因|','|---|---|---|']
    for d in daily:lines.append(f"|{d['date']}|{json.dumps(d['degradation_reasons'],ensure_ascii=False)}|{json.dumps(d['provider_bypass_reasons'],ensure_ascii=False)}|")
    lines+=['','## 边界与对照','',
        f"增加25.5°C、零储能保持设定对照：其配对费用{fmt(pooled['hold25_cost_cny'])}元，Agent差额{fmt(pooled['cost_reduction_vs_hold25_cny'])}元；其有效小时最大上界{fmt(pooled['hold25_upper_peak_kw'])}kW，Agent差额{fmt(pooled['upper_peak_reduction_vs_hold25_kw'])}kW。避免把固定升温的贡献全称作优化收益。",
        f"舒适degree-hours={fmt(pooled['comfort_degree_hours'])}，不是硬设定温度规则；末SOC列明，不要求日末回到起点。未计储能损耗、衰减、终端SOC价值，费用来自配置电价而非真实账单。",
        '当前+次小时历史模型/天气存在lookahead，不是验证过的实时两步控制；不声称区间上界场景削峰是实测/联合概率保证。PV/经济模型为配置线性工具，热表辅助代理未用于拟合节费。13天样本不是全年代表性检验；不为美化结果改日期或提示词/参数。',
        '逐小时证据在agent_eval_v1_hours.jsonl，包含输入上下文、全精度plan/candidates、经济分项、约束、工单、provider安全状态；binding记录代码/输入哈希。无key/request正文/原始失败provider文本日志。未改twin/或现有导出，不用计划任务、不改环境配置。']
    lines+=['',f"当前拒绝转人工率={100*pooled['current_refused_handoff_fraction']:.0f}%；无当前拒绝日标N/A，不冒称100%。最终source：{json.dumps(pooled['source_hours'])}；返回llm.mode：{json.dumps(pooled['returned_llm_mode_hours'])}。provider传输失败会返回mock状态但最终source仍rule，并非在mock配置下跑。",
        '无来源数字按现有ungrounded_numbers匹配器（小数精度数值工具叶、单段文本中去重token）统计，不是完整语义因果来源认证；日期/字符串不冒当数值证据。被拒草稿不等于最终解释缺陷。最终/候选硬约束检查包括24–27°C、|储能功率|≤500kW、SOC0.1–0.95；跨实际执行轨迹SOC也复核。',
        'pytest117项通过；新增离线重算312条证据的成本/峰值、SOC连续性、拒绝工单/不下发、grounding以及去重窗口与负收益不裁剪测试。无新增真实调用的离线测试。']
    REPORT.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(pooled,indent=2))


if __name__=='__main__':main()
