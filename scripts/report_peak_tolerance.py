"""Offline exact v4 aggregation, compare both economic baselines with v3."""
import json
from collections import Counter
from pathlib import Path
from scripts.evaluate_agent24 import PLAN,HOURS,BINDING
from scripts.evaluate_agent13 import dates
from scripts.report_agent13 import summarize
from scripts.report_agent24 import storage_metrics
from scripts.download_bdg2_thermal import sha
from src.agent.orchestrator import reason_format_invalid
from src.agent.selection import misleading_tradeoff


def binding_matches(path,expected):
    # Original binding is immutable; git may checkout unchanged sources as LF/CRLF.
    import hashlib
    data=Path(path).read_bytes();lf=data.replace(b'\r\n',b'\n')
    return any(hashlib.sha256(v).hexdigest()==expected for v in (data,lf,lf.replace(b'\n',b'\r\n')))


def report(rows):
    result={**summarize(rows),**storage_metrics(rows)}
    result['non_chinese_reason_runs']=sum(reason_format_invalid(r['result']['reason']+r['result']['selection_reason']['summary']) for r in rows)
    categories=Counter('rule' if r['result']['source']=='rule' else r['result']['explanation_source'] for r in rows)
    result['wording_categories']={k:categories[k] for k in ['llm','template','rule']}
    result['bad_tradeoff_runs']=sum(misleading_tradeoff(r['result']['reason'],r['result']['selection_reason']) for r in rows)
    result['hold25_cost_reduction_pct']=100*result['cost_reduction_vs_hold25_cny']/result['hold25_cost_cny']
    result['duplicate_display_metric_runs']=sum(len({tuple(round(a['objective_metrics'][k],1) if a['objective_metrics'][k] is not None else None for k in ['energy_cost_cny','upper_grid_peak_kw']) for a in r['result']['candidates']})!=len(r['result']['candidates']) for r in rows)
    return result


def main():
    plan=json.loads(PLAN.read_text());binding=json.loads(BINDING.read_text());assert sha(PLAN)==binding['plan_sha256']
    snapshot='experiments/agent_eval_v4_selection_snapshot.py'
    assert all(binding_matches(snapshot if p=='src/agent/selection.py' else p,s) for p,s in binding['code_sha256'].items())
    rows=[json.loads(l) for l in HOURS.read_text(encoding='utf-8').splitlines()]
    assert len(rows)==len({(r['date'],r['hour']) for r in rows})==312
    previous=[json.loads(l) for l in Path('experiments/agent_eval_v3_hours.jsonl').read_text(encoding='utf-8').splitlines()];old={(r['date'],r['hour']):r for r in previous}
    v2=[json.loads(l) for l in Path('experiments/agent_eval_v2_hours.jsonl').read_text(encoding='utf-8').splitlines()]
    days=[]
    keys=['cost_cny','baseline_cost_cny','hold25_cost_cny','cost_reduction_cny','cost_reduction_vs_hold25_cny','upper_peak_kw','upper_peak_reduction_kw','upper_peak_reduction_vs_hold25_kw']
    for item in dates(plan):
        selected=sorted([r for r in rows if r['date']==item['date']],key=lambda r:r['hour']);assert [r['hour'] for r in selected]==list(range(24))
        summary=report(selected);before=summarize([r for r in previous if r['date']==item['date']])
        days.append({**item,**summary,'delta_vs_v3':{k:summary[k]-before[k] for k in keys}})
    pooled=report(rows);before=summarize(previous)
    control=['hvac_setpoint_c','battery_kw','action']
    comparison={'delta':{k:pooled[k]-before[k] for k in keys},
        'first_controls_changed_hours':sum(any(r['result']['plan'][0][k]!=old[r['date'],r['hour']]['result']['plan'][0][k] for k in control) for r in rows),
        'economics_changed_hours':sum(r['economics']!=old[r['date'],r['hour']]['economics'] for r in rows),
        'forecast_changed_hours':sum(r['forecast']!=old[r['date'],r['hour']]['forecast'] for r in rows),
        'soc_changed_hours':sum(r['soc_before']!=old[r['date'],r['hour']]['soc_before'] for r in rows)}
    before2=summarize(v2)
    comparison2={k:pooled[k]-before2[k] for k in keys}
    result={'selection_snapshot_sha256':sha(snapshot),'final_selection_sha256':sha('src/agent/selection.py'),'comparison_to_v2':comparison2,'status':'completed','plan_sha256':sha(PLAN),'hours_sha256':sha(HOURS),'binding_sha256':sha(BINDING),'summary':pooled,'days':days,'comparison_to_v3':comparison,'policy':plan['selection_policy'],'limits':'fixed-policy regression on previously seen 13 days; configured scenario costs, accepted first steps only; not measured or full-day bill'}
    Path('experiments/agent_eval_v4_summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    lines=['# 峰值容差真实评测结果','','T=max(1 kW, p_min×0.1%)，评测前固定；容差内电费优先，再原峰、候选名。见docs/peak_tolerance_policy.md。旧v3文件不覆盖。','',
        '|日期|llm措辞|template且LLM选案|rule|规划费用 元|省24度基准 元|省25.5度基准 元|费用较v3变化 元|','|---|---:|---:|---:|---:|---:|---:|---:|']
    for d in days:
        c=d['wording_categories'];lines.append(f"|{d['date']}|{c['llm']}|{c['template']}|{c['rule']}|{d['cost_cny']:,.2f}|{d['cost_reduction_cny']:,.2f}|{d['cost_reduction_vs_hold25_cny']:,.2f}|{d['delta_vs_v3']['cost_cny']:,.2f}|")
    lines+=['','## 汇总',f"24 °C零储能基准 {pooled['baseline_cost_cny']:,.2f} 元 → Agent {pooled['cost_cny']:,.2f} 元，下降 {pooled['cost_reduction_cny']:,.2f} 元/{pooled['cost_reduction_pct']:.2f}%；25.5 °C零储能基准 {pooled['hold25_cost_cny']:,.2f} 元，下降 {pooled['cost_reduction_vs_hold25_cny']:,.2f} 元/{pooled['hold25_cost_reduction_pct']:.2f}%。跨日有效小时最大上界峰值 {pooled['upper_peak_kw']:,.2f} kW，相对两基准差 {pooled['upper_peak_reduction_kw']:.2f}/{pooled['upper_peak_reduction_vs_hold25_kw']:.2f} kW。较v3成本变化 {comparison['delta']['cost_cny']:,.2f} 元、峰值差 {comparison['delta']['upper_peak_kw']:.2f} kW。",'','较v2（旧完整门控路径亦不同，不能全归因容差）全精度差：',json.dumps(comparison2,indent=2),'',json.dumps({'cost_cny':pooled['cost_cny'],'savings24':pooled['cost_reduction_cny'],'savings25':pooled['cost_reduction_vs_hold25_cny'],'source_categories':pooled['wording_categories'],'delta_vs_v3':comparison},ensure_ascii=False,indent=2),
        '', '零约束/terminal SOC违规和零最终无来源数字需查看summary，provider超时/验证回退保留、非成功不算LLM；末SOC/单日负收益详表，不删除差日。峰值容差可能换取最多容差内更高窗口峰值，不保证实际逐小时/全日峰单调下降。2017已见样本，本次固定政策回归不是盲测；不借结果调整阈值。配置线性费用/单位效率/无损耗、未来天气持久性、拒绝小时排除，非实测账单。',
        '', '三天export是另一个实际provider批次，不能拿其来源替换13天来源。导出被598秒部署上限终止一次，checkpoint保存normal24/peak24/abstain3后只续未保存21小时；可能有1个在途未保存调用，既无结果不计通过、也不假称provider总尝试可完全核实。评测312小时各保存一次；其四次运行均正常paused/completed无杀进程。密钥无请求响应正文，不改前端/常驻服务。']
    lines+=['','## 离线加固与验证','原评测binding未改写；selection原代码完整保存在agent_eval_v4_selection_snapshot.py，其SHA等于binding。最终selection只加强去重前锚点传递、原始gain留存、拒绝显式容差内付费收益与避免把刚过容差的原值四舍五入后描述为容差值。不改变本批已保存控制、经济和来源；offline检验对全部312输入重建候选要求新旧控制相同。未拿2017结果调阈值或提示词，不重跑失败结果。','三天已保存导出需按最终防护离线审查：不调用provider、不改控制和经济，若措辞违规才改template，回执peak_tolerance_offline_validation.json记录SHA和来源。','pytest及凭据扫描完成情况见同一offline回执；独立子任务执行失败，无独立通过声明。','', '每日末SOC：'+json.dumps({d['date']:next(r['soc_after'] for r in rows if r['date']==d['date'] and r['hour']==23) for d in days})]
    Path('experiments/agent_eval_v4_report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'summary':pooled,'comparison':comparison},indent=2))


if __name__=='__main__':main()
