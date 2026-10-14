# 当前1.3：以起点t展示未来24步

新增热表及空调电耗代理、日占比、楼层HVAC/非HVAC守恒分项；详hvac_meter_contract.md。三天Agent已真实重新run_agent，selected及selection_reason同属显式上界峰值优先目标，不再只附历史审计；源数量和降级原因见agent_replay_export.json。

当前normal2017-10-23、peak2017-07-20、abstain2017-07-04（独立日）。每小时含recent_actual(t−1,t)及forecast_24h(t+1…t+24)，预测使用byron-blend24-monthly-v3起点因果缓存与每步CQR/gate：h1同月精确匹配下一小时原一步模型，其余固定分段，h3-6重叠专家慢过渡混合后重新校准；跨月保留起点月模型，不借下一月已更新模型。无前一天回放字段。当前小时预测仍属旧1step模型、非多步h0；Agent用同目标重新选择，storage/grid/SOC及理由刷新；存储/PV/grid仍派生/模拟，调度log_only。本次Agent刷新经用户授权真实调用LLM，热表附加/未来模型导出不调用LLM。

楼层2F/39F为假设机房，固定密度/用途曲线加seed42±4%权重抖动，当前和未来每个point以0.1kW最大余数法精确守恒；详floor_allocation.md。覆盖/MAE/拒绝率逐步报告见experiments/multi_horizon_v3_report.md；h3-6达到经验90.5%，其它步长未达，非联合路径保证。接缝改善，h6-7变化量误差稍增如实保留。下列内容是早期v1历史记录，不是当前契约/模型/日期。

## 历史归档：原v1回放

主楼 `Hog_office_Byron`（云栖塔显示名），BDG2 2017 年完整小时电表；CQR profile 与参数在pilot验证选定，最后15%（2017-11-07 06:00原始墙钟至12-31）只用于一次最终评估。按要求从测试中挑有代表性的三天是**回放场景挑选**，不是模型性能代表抽样、阈值调参或覆盖保证。选择顺序和规则预先写在代码：完整24小时普通工作日中拒绝≤2取最少拒绝/最低平均风险；剩余最高实际峰值日；剩余最多拒绝/最高平均风险日。**测试期是冬季，因此peak为高负荷日而非高温日，不能配“炎热天气”文案。**

| 场景 | 日期 | 拒绝小时 | 实测日峰值 kW | 当日最高气温 | 含义 |
|---|---|---:|---:|---:|---|
| normal | 2017-12-05 | 1/24 | 1275.3 | −2.8 °C | 普通工作日，23小时建议、1小时人工接管 |
| peak | 2017-12-07 | 4/24 | 1299.8 | −6.1 °C | 测试期最高负荷峰值日，允许时段展示模拟储能削峰 |
| abstain | 2017-11-23 | 15/24 | 932.7 | 8.9 °C | 高拒绝日，可能是节假日/工况变化，不把代理解释当作已证实原因 |

数据：`exports/replay/{normal,peak,abstain}.json`、`index.json`；84栋其它全年完整园区楼，逐楼24个小时预测（全局候选 `hog2017-v1`），主楼为单楼 `byron2017-v1-cqr` profile，**并非在线champion已替换**。`sample.json`是mock且不进入列表。每场约94KB，小于2MB。已有 `/predict` 单步契约不变；回放GET直接读取已校验导出文件，不给场景重新推理。

## 来源与语义

- 实测用量为原始每小时kWh，在一小时区间上作为平均kW；预测和区间来自相同已冻结模型。整楼才有拒绝标记；楼层只估算，不生成楼层置信/拒绝。
- 楼层40层为80038.2/40≈2001.0 m²估算；1F大堂、14F/27F花园，其余Office。权重为相等楼层面积×用途系数（lobby .7、garden .4、office 1）×日内曲线（办公8–17时1.12、其它.95）。用十分之一kW的最大余数分配，40层之和精确等于四舍五入的point，非实测楼层负荷。
- 储能2MWh/500kW；初始SOC .5，上下限.1/.9，功率正放电负充电，小时积分。示例peak夜充80kW、午后在point超过**训练段P80=1172.5292kW**时放140kW；没有用当日未来实际值决定调度。效率1是假设，模拟数据不代表真实收益。拒绝小时功率0、actions为空，只人工接管。
- PV 180kWp，依据墙钟6–18时正弦和观测云量的衰减模拟；缺云量用4.5代理。云量非辐照度，日长没有按冬季优化，光伏非实测。`grid_kw=max(0,actual_kw−storage.power_kw−pv.power_kw)` 为**回顾性模拟购电量**，不是工具输出的预测或真实电网表，标为simulated_fields。
- `confidence=.905`是标称前选择水平，不是小时正确概率；SOC保留3位、confidence3位，其余负荷1位，以避免将0.905误写成0.9或SOC1位造成能量账不一致。
- 原始时间无偏移，内部为旧特征适配暂贴UTC标签；导出按元数据`US/Central`墙钟附 `America/Chicago` 偏移（三天均−06:00），不是把旧UTC标签二次转换。场景都不跨夏令时切换。不能据此宣称跨时区实时部署已验证。
- 主楼模型15%目标实际测试拒绝19.71%，保留PICP **87.68% <90.5%**；因此全部方案 `proposed`/`handoff`、`source=rule`，**需要人工确认，不自动控制**。无API key不冒充LLM。

复现：`python -m scripts.audit_hog` → `python -m scripts.prepare_hog2017` → 保存配置训练模型/固定候选搜索（见experiments）→ `python -m scripts.save_replay_profile`（不可覆盖版本）→ `python -m scripts.export_replay` → `python -m scripts.export_buildings` → `python -m pytest -q`。包和预测缓存完整性绑定 `experiments/replay_provenance.json`；原始文件/模型joblib保留本地不提交。
