"""Read-only evidence aggregation: cost each executed current step once, two baselines."""
import json,re
from pathlib import Path
import pandas as pd
from scripts.report_agent13 import summarize
# Historical v2 report must never follow the active evaluator to a newer batch.
PLAN=Path('experiments/agent_eval_v2_plan.json')
HOURS=Path('experiments/agent_eval_v2_hours.jsonl')
BINDING=Path('experiments/agent_eval_v2_binding.json')
from scripts.evaluate_agent13 import dates
from scripts.download_bdg2_thermal import sha


def storage_metrics(rows):
    powers=[r['result']['plan'][0]['battery_kw'] for r in rows]
    return dict(charging_hours=sum(p< -1e-6 for p in powers),discharging_hours=sum(p>1e-6 for p in powers),
        charge_kwh=-sum(min(0.,p) for p in powers),discharge_kwh=sum(max(0.,p) for p in powers),
        final_soc_by_day={d:sorted([r for r in rows if r['date']==d],key=lambda r:r['hour'])[-1]['soc_after'] for d in sorted({r['date'] for r in rows})},
        duplicate_candidate_runs=sum(len({tuple((p['timestamp'],round(p['battery_kw'],6),p['hvac_setpoint_c'],p['action']) for p in a['plan']) for a in r['result']['candidates']})!=len(r['result']['candidates']) for r in rows),
        non_chinese_reason_runs=sum(bool(re.search('[A-Za-z]',r['result']['reason']+r['result']['selection_reason']['summary'])) for r in rows),
        terminal_soc_violation_runs=sum(sum(p['battery_kw'] for p in r['result']['plan'])>1e-5 for r in rows))


def main():
    rows=[json.loads(l) for l in HOURS.read_text(encoding='utf-8').splitlines()];plan=json.loads(PLAN.read_text())
    binding=json.loads(BINDING.read_text());assert sha(PLAN)==binding['plan_sha256']
    assert all(sha(p)==h for p,h in binding['code_sha256'].items()),'Frozen code changed'
    assert len(rows)==312 and len({(r['date'],r['hour']) for r in rows})==312
    daily=[]
    for item in dates(plan):
        rs=sorted([r for r in rows if r['date']==item['date']],key=lambda r:r['hour']);assert [r['hour'] for r in rs]==list(range(24))
        daily.append(dict(**item,initial_soc=.5,final_soc=rs[-1]['soc_after'],**summarize(rs),**storage_metrics(rs)))
    pooled={**summarize(rows),**storage_metrics(rows)}
    pooled['cost_reduction_vs_hold25_pct']=100*pooled['cost_reduction_vs_hold25_cny']/pooled['hold25_cost_cny']
    pooled['upper_peak_reduction_vs_hold25_pct']=100*pooled['upper_peak_reduction_vs_hold25_kw']/pooled['hold25_upper_peak_kw']
    result=dict(status='completed',requested_llm_mode='real',policy=plan['selection_policy'],plan_sha256=sha(PLAN),binding_sha256=sha(BINDING),hours_sha256=sha(HOURS),
        economic_scope='only accepted executed current step; full rolling window candidate costs not summed twice',dates_replaced=False,retuned=False,days=daily,summary=pooled)
    Path('experiments/agent_eval_v2_summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    pd.DataFrame([{k:v for k,v in d.items() if not isinstance(v,dict)} for d in daily]).to_csv('experiments/agent_eval_v2_days.csv',index=False)
    def fmt(v):return '无' if v is None else f'{v:.2f}'
    lines=['# 二十四小时储能滚动规划：原十三天名单复评','',
        '## 冻结协议','',
        '先冻结agent_eval_v2_plan及代码/数据binding，沿用v1的三典型日与十个纯日历日，不按收益换日。2016已选定的预测模型/多步接缝/门控不改；本轮只改控制规划，不以2017结果重新调参数或提示。各日初电量50%，仅已保存小时用于续跑、不重复已完成小时。','',
        '每小时当前历史一步预测与该起报点forecast_24h的后续一至二十三小时构成完整二十四步窗口；没有把次小时指令错贴到本小时。当前天气持久性、当前光伏取起点已知值、未来光伏保守为零，不使用未来实测天气。候选费用按窗口所有通过门控小时求和；拒绝时段费用不伪填零。评测汇总只计本小时实际执行首步，不重复累加重叠窗口。','',
        '谷段可充、峰段可放、其他及拒绝小时功率零，电量10%至95%、功率不超过500千瓦。全额/保守用500/250千瓦上限，保持候选零功率；相同轨迹合并。温度保持25.5度，不采用无物理收益支撑的预冷。优化先最小上界峰值，再最小电费，再最小吞吐；每个窗口末电量不低于起点。每小时只下发首步的楼控与储能两条日志指令，未接真实设备。','',
        '## 按天两组基准','',
        '|日期|有效/拒绝|充/放小时|24度基准→规划费用 元|相对24度差额 元|25.5度保持费用 元|相对25.5度差额 元|上界峰值24度/25.5度/规划 千瓦|末电量|',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for d in daily:
        lines.append(f"|{d['date']}|{d['accepted_hours']}/{d['current_refused_hours']}|{d['charging_hours']}/{d['discharging_hours']}|{fmt(d['baseline_cost_cny'])}→{fmt(d['cost_cny'])}|{fmt(d['cost_reduction_cny'])}|{fmt(d['hold25_cost_cny'])}|{fmt(d['cost_reduction_vs_hold25_cny'])}|{fmt(d['baseline_upper_peak_kw'])}/{fmt(d['hold25_upper_peak_kw'])}/{fmt(d['upper_peak_kw'])}|{100*d['final_soc']:.2f}%|")
    lines+=['','## 汇总与安全','',
        f"312小时，有效{pooled['accepted_hours']}、当前拒绝{pooled['current_refused_hours']}；充电{pooled['charging_hours']}小时、放电{pooled['discharging_hours']}小时，充/放电量{fmt(pooled['charge_kwh'])}/{fmt(pooled['discharge_kwh'])}千瓦时。",
        f"相对24度：费用{fmt(pooled['baseline_cost_cny'])}→{fmt(pooled['cost_cny'])}元，下降{fmt(pooled['cost_reduction_cny'])}元（{fmt(pooled['cost_reduction_pct'])}%）；跨日有效小时最大上界峰值{fmt(pooled['baseline_upper_peak_kw'])}→{fmt(pooled['upper_peak_kw'])}千瓦，下降{fmt(pooled['upper_peak_reduction_kw'])}千瓦（{fmt(pooled['upper_peak_reduction_pct'])}%）。",
        f"相对25.5度保持：费用{fmt(pooled['hold25_cost_cny'])}→{fmt(pooled['cost_cny'])}元，下降{fmt(pooled['cost_reduction_vs_hold25_cny'])}元（{fmt(pooled['cost_reduction_vs_hold25_pct'])}%）；最大上界峰值{fmt(pooled['hold25_upper_peak_kw'])}→{fmt(pooled['upper_peak_kw'])}千瓦，下降{fmt(pooled['upper_peak_reduction_vs_hold25_kw'])}千瓦（{fmt(pooled['upper_peak_reduction_vs_hold25_pct'])}%）。",
        f"硬约束违规运行/候选{pooled['violating_runs']}/{pooled['violating_candidate_plans']}，窗口末电量违约{pooled['terminal_soc_violation_runs']}，重复候选运行{pooled['duplicate_candidate_runs']}，非中文最终理由{pooled['non_chinese_reason_runs']}，最终无来源数字{pooled['explanation_unsourced_numeric_token_count']}。",
        f"当前拒绝转人工{pooled['current_refused_handoff_correct']}/{pooled['current_refused_hours']}；重叠窗口拒绝步安全核对{pooled['refused_steps_correct']}/{pooled['refused_steps_checked']}。电量轨迹范围{100*pooled['soc_min']:.2f}%至{100*pooled['soc_max']:.2f}%。",
        f"真实配置：验证成功{pooled['validated_real_llm_hours']}小时，调用后规则降级{pooled['degraded_hours']}，门控绕过{pooled['provider_bypass_hours']}；原因{json.dumps(pooled['degradation_reasons'],ensure_ascii=False)}；传输成功{pooled['provider_transport_succeeded_calls']}/{pooled['provider_calls']}次，不等同验证成功。拒绝草稿无来源数字{pooled['rejected_provider_unsourced_numeric_token_count']}，不保存草稿原文。",
        f"不能用汇总掩盖单日负收益：相对25.5度保持，十三天中{sum(d['cost_reduction_vs_hold25_cny']<0 for d in daily)}天费用更高、{sum(d['upper_peak_reduction_vs_hold25_kw']<0 for d in daily)}天日内最大上界峰值更高。部分低负荷/拒绝日谷段充电但当天不放电，电量留到后续窗口，不能声称逐日都节费削峰。",
        '', '## 限制与复现','',
        '选择仍严格按未舍入上界峰值排序，不把显示一位小数当作精确平峰。normal14全额/保守显示同为1179.9千瓦，但原始峰值1179.902500208106/1179.9025，保守低约0.000000208千瓦，故被优先选择而多花3.5元；这是浮点/求解容差级别的选择敏感性，不是有实际意义的削峰收益。没有用2017结果临时改排序或重跑小时来消除它；需要后续单独冻结数值容差策略验证。',
        '原v1经济结果不能当成严格同输入消融：本轮改用起报因果未来预测/天气持久性，之前是次小时历史一步与实测未来天气；两组基准均按本轮同输入/同门控重新计算。没有把固定升温贡献都叫作储能优化收益。',
        '所有费用都是配置电价、线性负荷、单位效率下的情景结果，非实测账单；不含损耗/衰减。拒绝小时排除，因此不是完整日账单或全天峰值；区间上界不是联合概率保证。日末电量未强制回到日初，每窗口末不低于窗口初，跨日储能残值未计入收益，仍须结合末电量解读。十三天是已见样本，并非全年或盲测证据。',
        '脚本python -m scripts.evaluate_agent24续跑仅未完成小时；python -m scripts.report_agent24离线重算。不联网的pytest复核全精度SOC、同门控、逐首步成本、候选费用及两基准。计划/代码/模型缓存/天气哈希绑定，原v1证据保留。',
        '若长工具调用超时，只从已保存逐小时checkpoint续跑；可能中断的未保存provider请求不计为验证通过或成功小时，不为了美化完成记录重跑已保存小时。',
        '密钥只原运行文件读取，无请求/响应正文/密钥日志。不用计划任务、不改环境配置、不修改前端。契约仍1.3，无新增对外字段；现有candidates.plan延长24项，现有selection_reason.summary写留电时段与规划边界。后端常驻scripts.serve_backend需用户重启加载。']
    Path('experiments/agent_eval_v2_report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(pooled,indent=2))


if __name__=='__main__':main()
