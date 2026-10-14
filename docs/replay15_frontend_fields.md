# Replay 1.5：前端接入字段

本轮不修改 `twin/`。前端需要同步根目录 `contracts/replay.schema.json`（1.5，兼容上一版1.4）、保留 `contracts/replay-1.4.schema.json`，扩展 ReplayData.schema_version，并注册1.5校验器；当前看板只注册到1.4，直接加载新导出会拒绝，不能称为已完成前端联调。

## 主文件：默认加载

`exports/replay/{normal|peak|abstain}.json`。仍有24个小时、每小时24个起报预测点；时间戳、horizon、模型版本、拒绝状态和来源标记不变。

每小时 `agent`：

|字段|用途|
|---|---|
|status / source / explanation_source|执行状态、选案来源、文字来源，彼此独立|
|selected|选中candidate_id|
|explanation|已核验值班文字|
|hvac_setpoint_c / actions|当前温控设定与动作|
|receipt|count、elapsed_ms、transport、device_connected，日志回执摘要|
|candidate_summaries[]|默认候选对比，不读取plan/simulation|
|planning_horizon_hours|费用比较窗口小时数；不要退回一小时口径|
|ticket_summary（可选）|当前小时首条人工工单摘要|
|detail_index|本小时详情索引，整数0..23|

候选摘要映射：

```text
Candidate.id       <- candidate_id
Candidate.temp     <- hvac_setpoint_c
Candidate.battery  <- battery_kw (正放负充)
Candidate.cost     <- energy_cost_cny (整段接受小时费用，非单小时)
Candidate.peak     <- point_grid_peak_kw (保留旧默认图的点负荷口径)
upper peak         <- upper_grid_peak_kw (负荷偏高时的峰值)
Candidate.passed   <- constraint_valid
accepted/excluded  <- accepted_hours / excluded_hours
costWindowHours    <- agent.planning_horizon_hours
selected           <- agent.selected
reason             <- agent.explanation
receipt            <- agent.receipt
Ticket             <- agent.ticket_summary
```

不要因为没有 `candidates[].plan` 回退到 ruleCandidates：那会把24小时窗口替换为前端一小时计算。`twin/src/pages/agent/data.ts` 当前还有这类旧读取，需看板会话迁移。状态与回执摘要字段保持原有结构。

## 详情：按需加载

`meta.agent_detail_file` 是同目录白名单文件名，例如 `normal.agent-detail.json`。以 `String(agent.detail_index)` 读取 `detail.hours[index]`；不是用目标预测时刻，也不是字符串“07:00”。

```text
detail.schema_version = "1.5"
detail.scenario / building_id = 主文件标识
detail.main_sha256 = 对应主文件原始UTF-8字节的SHA256
detail.origin_metadata = 原始工程常量和门控阈值证据
detail.hours["7"].t = 对应主文件hours[7].t
detail.hours["7"].agent = 完整旧Agent：candidates、plan、simulation、
                         selection_reason、llm/调用元数据、工单与原回执
detail.hours["7"].runtime_evidence.numeric_overrides[] =
                         path/value形式的原始非显示数值证据
```

详情不应首屏预加载，也不要把 runtime_evidence 当图表显示源。后台按对应小时加载、核对文件名/场景/楼宇/时刻/主文件hash；错配返回数据不可用，不编造替代理由。

## forecast_24h

保留 `t/horizon/point_kw/lower_kw/upper_kw/confidence/abstain/risk_score/risk_threshold/confidence_threshold/floors_kw`。`floors_kw` 被 `twin/src/data/validate.ts` 守恒校验读取，不能删。风险和置信阈值也被Agent/预测页读取，不能删除。

移除的旧可选字段：`hvac`、`hvac_electric_estimate_kw`、`hvac_electric_estimated_share`、`floors_hvac_electric_estimate_kw`、`floors_non_hvac_estimate_kw`、`weather`。grep没有发现前端业务读取这些未来点字段（仅类型声明）；它们可由起报小时的天气/过去表计、目标月份、point_kw、floors_kw及meta.hvac_method重建。当前小时的同名字段仍保留。

精度：功率/电量/费用/温度/坐标最多1位，置信度/风险/SOC/占比最多4位；采用十进制最近值half-even，不是向零截断。布尔门控沿用原判断，不从缩短后的概率重新判断。工程常量、ID、次数和时间戳不截断，运行证据原精度保留在详情。楼层数组既有0.1kW最大余数守恒不变。

## 后端

`/replay/{scenario}` 返回轻量主文件；`/chat`、`/chat/stream`、`/schedule`、`/explain`读取对应小时完整证据。现有问答事件名不变。后端需要重启；本轮未重启常驻服务。
