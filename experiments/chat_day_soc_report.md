# 当地日期峰值问答与SOC单一快照修复

## 问答

现有intent只命中“峰值/最高负荷/最大负荷”，漏掉“今天哪个小时的预测负荷最高？”。补语序别名及规则hint；真实LLM选择unknown或错工具时不允许丢弃明确意图，回规则执行get_forecast→forecast_peak。

今天：从起报当前行t的forecast_24h取t+1起、按t的timezone比较同一个当地日期，只在今天剩余预测小时找最大point。既不混入次日的更高值，也不混入当前旧1step或已过去负荷。正常起报2017-10-23T14:00:00-05:00有9个今日剩余小时，最高在今天15:00、1250.1kW（门控通过）。次日可用15小时可能不覆盖完整次日，因此明确只在可用预测小时比较。未来24h问题保持原完整窗口校验；23h问今天只读get_forecast，返回空范围说明，不用次日顶替、不无故转人工。目标日期按起报offset，测试将目标t转换成UTC仍按当地日筛选；今天剩余23h在UTC可能已是次日。

JSON/SSE共享pipeline，tool_start/end/answer_delta/done字段与名字未变。LLM必须保留日期及范围，不得将今天剩余称为全天。未增加真实LLM调用/重导出；离线demo与模拟真实模式覆盖选择错误fallback。

## SOC来源与复核

回放1.3字段storage.soc来自scripts/export_agent_replay.py：每日soc=.5起，执行当前selected battery_kw后soc-=power/2000，保留6位。不是电池表计，是单位效率积分的派生状态。current_state和能源页EnergyPage.tsx直接读当前hour.storage.soc；Agent页DecisionCard.tsx当前上下文展示也读该字段。源代码只读检查，未改twin/。

get_context原先填previous，第一条填配置初值，因此它与当前snapshot有时不一致。现改由共用replay_soc(row)校验/读取当前行，显式source/basis；当前问答和what-if上下文也用相同helper。/schedule与/explain initial_soc从这一snapshot开始，只表示从当前快照起的新比较，不是再应用一次历史指令。历史导出/13天评测的事前SOC积分协议保持不变。

77.5%证据：git show 4c5fa59:exports/replay/normal.json的13/14h均soc=.775；当前72ef951刷新后的13/14h为.5，而且normal24h都是.5。故normal77.5→50不是当前两个端点在不同功率积分方式下产生的差，而是旧回放充电方案残留/旧缓存的数值。无法从源码确定上线旧进程/浏览器到底缓存了哪一版本，不声称已替用户刷新上线服务。当前后端与数据口径统一；前端若仍显77.5需重新获取现有/replay/normal，不能继续用旧缓存。

不需重导出：现有三天每一行soc均满足前行状态−该行power/2000（每日初值.5），两页/问答展示字段一致。修复未更改exports/、模型或schema；未调用provider刷新控制，不把API快照adapter改动偷换成模型/策略更新。测试还构造上一行.775、当前.4且power=200，锁住读取40%不是77.5%、也不是扣两次后的30%；捕获/schedule和/explain传入初值.4且不改回放。

## normal评测为何储能不动（只诊断不修改）

证据：agent_eval_v1_hours.jsonl中normal24条当前command，setpoint均25.5、battery_kw均0；初末SOC=.5。最终selected有rule_hold和rule_conservative，后者若数值完全同分只是candidate_id平局优先，并不证明有储能动作。对24°C基准省951.54元/4.74%、上界峰值57.27kW/4.84%，对25.5°C不调度费用和峰值差均0。

1. 两小时窗口：谷段候选rule_full/rule_conservative在0–6h尝试充100/50kW，没有跨到白天高价/削峰时段，也没有末SOC价值。0h两步上界峰值full861.105、conservative811.105、hold761.105kW，费用595.166/560.166/525.166元；充电同时恶化短窗峰值和费用，按峰值优先自然选hold。缺乏长视窗确实使未来套利收益不计入，但不应仅断言加长窗口必有收益：同一lexicographic峰值目标可能仍阻止充电。
2. 放电候选触发规则独立于LLM：need=max(0,upper−PV−peak_target)，peak_target=1186.8466kW。normal10–19h upper−PV−target范围−162.0673到−3.2610kW，全部负数，即使SOC足也生成零放电。14h upper1282.2475−PV114.3−target1186.8466=−18.8991，因此不是因为没夜充才不放电；.5已有800kWh可用电量到min_soc=.1。
3. 预冷：full/conservative看next upper高时24.5°C且额外+5%负荷；未建后续温度/热蓄能带来的负荷下降，只有当窗增加成本/峰值。14h两步hold峰1126.3148kW/2632.3439元 vs full/conservative1212.8261kW/2753.2916元，因此hold支配其他候选。固定25.5°C对24°C的3%/°C线性降载是该日全部费用收益来源，不是储能套利或实测节费。

本次不改候选、目标、窗口、阈值或13天评测数字。不重新用2017挑策略。将来若长窗口或终端SOC实验，需另立冻结开发协议，不混在路由/SOC修复里。

## 验证

新增当地日别名/真实模式错路由/下一日更高值/UTC跨日/23h无剩余/SSE工具顺序测试；三天72行context+问答SOC与原回放/能源字段一致；fixture验证非恒定SOC、初值/功率不重复施加及非法SOC拒绝。完整测试结果见本次提交PROGRESS。凭据仅运行时读取；无key、请求正文或原始provider输出日志。无后台服务接管、无环境配置变动。
