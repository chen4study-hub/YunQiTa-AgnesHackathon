# 契约1.3：Byron热表与空调电负荷归因

## 下载、校验及单位

`python -m scripts.download_bdg2_thermal --workers 16 --seconds 100` 匿名官方media源分段下载；每段验证Content-Range，拼接后用官方LFS oid做完整SHA256、长度校验。不匹配删除拼接文件及分段、重试；正式文件失败也删除重下。未完成数据只能是part/chunks，不作为输入。curl -q不读用户curl配置，无LLM/key读取。日志`logs/download_bdg2_thermal.jsonl`记录安全的时间、字节数、退出码、校验结果。未使用计划任务，未改环境变量或系统配置。早期公共镜像HEAD返回403，最终两表均来自官方media源。

|文件|字节数|官方SHA256|
|---|---:|---|
|chilledwater_cleaned.csv|77005463|8211aaf210379af50cbf7af87579d12414c3500d3e3f4dea725761c93a172bcd|
|steam_cleaned.csv|45422530|ea5956c49ed1d6cc1b611a752b5a9dc3bcd4d45ddcd674e53b3c41661a6d3b9b|

来源锁`experiments/bdg2_thermal_sources.json`；每次导出再检查完整文件哈希。Byron列`Hog_office_Byron`，两表各17544行。官方[Meter features](https://github.com/buds-lab/building-data-genome-project-2/wiki/Meters-data-features)指出能源表已统一kWh、timestamp为本地时间、每小时读数；不能重复套Kaggle表tons/lbs换算。清洗版会把异常及长期零值改NaN，因此NaN不等于零。蒸汽为供热热量、冷冻水为交付冷量；均非楼内电分项。

## 固定假设，未经2017拟合

- 热功率：小时kWh / 1h，保留在`hour.hvac.thermal_kw`，单位kW thermal。
- 当前method_version=building_auxiliary_thermal_v2。假定区域冷站/供热生产侧在整楼电表外，只计楼内送风机及二次循环水泵，**排除冷机压缩机、冷却塔及锅炉**。BDG2未给电表边界图，因此这是边界情景假设，不宣称已证实。
- 夏季6-9月：冷冻水热功率×0.0447020183；冬季11-3月：蒸汽热功率×0.02064201785。过渡季4/5/10相加。系数不是任意百分比/COP调整，以下由流量与压差公式推导；不得将热量当电耗。
- 来源：[EnergyPlus9.6风机工程公式](https://bigladdersoftware.com/epx/docs/9-6/engineering-reference/air-system-fans.html)给P=体积流量×压差/总效率；[泵参数/功率公式](https://bigladdersoftware.com/epx/docs/9-6/input-output-reference/group-pumps.html)给P=流量×扬程×轴功率系数/电机效率，默认扬程179352Pa及轴功率系数1.282051。公式来源已核读，未把来源说成Byron设备实测。
- 风机热量比例f=0.6、风压500Pa、总效率0.6、空气ρ=1.2kg/m³/cp=1006J/(kgK)、冷/热送风温差12/25K；水ρ=1000、cp=4180、冷/热水温差6/15K，电机效率0.9。f、风压、效率、盘管温差均为**事前固定工程假设**，不是EnergyPlus规定值或Byron实测。蒸汽通过假定二次热水盘管间接供热。
- 对每kW热量，风机系数f×ΔP_air/(ρ_air×cp_air×ΔT_air×η_fan)；泵系数ΔP_water×1.282051/(ρ_water×cp_water×ΔT_water×η_motor)。冷风机0.03451513+泵0.01018689=0.04470202；暖风机0.01656726+泵0.00407475=0.02064202（精确程序值以上为准）。简化为线性负荷比例，未模拟VAV控制曲线或最低通风，不能证明真实分项电耗/节费。
- 事前plan=experiments/hvac_auxiliary_v2_plan.json只有1候选。仅2016检查并冻结，8663配对有效小时，无裁剪；未裁剪全年份额29.15%、小时中位29.61%、P05/P95=12.74/45.81%、最大64.85%。剩余121小时是电表/热表缺测，不填零。验证见hvac_auxiliary_v2_development.json；不使用2017挑参数。
- 外部量级参照：[EIA2018 CBECS TableE5](https://www.eia.gov/consumption/commercial/data/2018/ce/xls/e5.xlsx)Office列，全年总227、spaceheating13、cooling23、ventilation63（billionkWh）：通风27.75%，完整HVAC43.61%。我们的29.15%为楼内辅助范围，不含区域生产，与统计边界不同，**这只提供量级参照，不是“办公楼常见占比区间”或小时保证**。5–60%为本工程宽松事前检查线，不是EIA发布的百分位。
- 2017三天导出是冻结参数的结果核对，若异常如实报，不调系数使看板好看。旧COP5口径因约99%且全裁剪被替换；报告历史保留，不隐藏此前问题。
- 原始当前小时读数分别放`hvac.effective_readings.chilledwater/steam.raw_kwh`；缺测则null。最多取t及以前24h内最后有效值，记录effective_kwh/source_wall_time/age_hours/quality。超过24h仍无必要季节热表，电负荷/占比/楼层分项返回null，不填零，不借未来值。

## 电负荷与占比（前端交接）

- 当前小时`hvac_electric_estimate_kw`：按上述口径算，并裁剪至`min(actual_kw,point_kw)`；额外point约束保证既有预测楼层总量中能容纳该分项。保留`hvac.uncapped_electric_estimate_kw`、`cap_applied`，不能隐藏裁剪。0.1kW输出不越界。
- `hvac_electric_estimated_share` = 上述电负荷 / **整栋当小时实测电负荷actual_kw**；0分母或缺测 => null。显示名必须带“空调电耗占比（估算）”，不是热量占比，不是全部电力表项实测。
- `energy_summary.hvac_electric_estimate_kwh`、`matched_building_electric_kwh`、`hvac_electric_estimated_share`用于能源页日汇总：配对有效小时电量之比，非小时占比算术平均，含valid_hours/total_hours、past_fill_hours/cap_applied_hours。
- `forecast_24h`对应字段：仅持久化起点热表，季节随目标月份已知切换，裁剪至未来point_kw，分母也是point_kw；没有未来实测读数、不借用未来电表作上限。basis=persistence_at_origin，origin明确绑定起点。
- 所有电负荷、占比、楼层分项和未来热表代理已列入meta.estimated_fields，meta.hvac_method完整保存参数/口径，meta.thermal_sources保存哈希来源。

## 楼层守恒

保留原`floors_kw`（整栋point_kw预测电力40层）的固定密度/用途/seed42±4%差异。以原楼层电力份额按0.1kW整数最大余数法分出`floors_hvac_electric_estimate_kw`，逐层上限为原floors_kw，剩余为`floors_non_hvac_estimate_kw`。因此：

1. sum(floors_kw)=point_kw，原预测不改；
2. sum(floors_hvac_electric_estimate_kw)=hvac_electric_estimate_kw；
3. 每层HVAC+非HVAC=原楼层预测电力；HVAC不是额外加到整栋电表；
4. 缺测时两分项null、原楼层总量仍有效。

所有主数据/样例仍1.3；本次经授权真实重跑run_agent，用新目标刷新Agent/储能/grid、selected与selection_reason一致，并记录LLM和规则数量；热表导出本身不调用LLM。`twin/`同步schema、类型、能源和楼层页由前端会话处理；后端仅提供字段，未改前端mock或断言它已替换。

许可：BDG2及改编导出CC BY-SA4.0；详THIRD_PARTY_NOTICES与exports/replay/LICENSE。
