# ops 1.0 接入字段

契约：`contracts/ops.schema.json`。生成：`python -m scripts.export_ops`；只读复核：`python -m scripts.export_ops --check`。

## 日期和时间

先加载 `exports/replay/ops-calendar.json`，按 `days[].date` 取 `scenario`、`source_date`、`day_start_ms`，再加载 `{scenario}.ops.json`。静态文件的 `day_start_ms=0` 是未绑定日期的锚点；绑定时只替换这一个字段。全部业务值和梯种子以 `meta.source_date` 为键。同一文件重复绑定到不同显示日期，其余字节不变。GET /ops/day 使用同一文件和编码，绑定后静态与 API 字节相同。

小时 `offset_ms`、电梯 `depart_ms/arrive_ms`、事件 `offset_ms/resolved_offset_ms` 都是零点起的毫秒偏移。绝对时间等于 `day_start_ms + offset`。编号不含日期；跨日列表用日期和编号组成组件 key，不修改显示编号。

跨午夜时间窗需按日期表加载每个相交日期的文件，分别加其 `day_start_ms` 再筛选；不能把当天数组 `%24` 接回首小时。前一天文件的 18–23 小时用于显示日期的昨日列表。`history.hours` 则是 `meta.source_date` 的前一天真实计量来源最后六小时，偏移为 -21600000 至 -3600000；不等于显示日期前一天的另一条来源路线。两者按页面口径选择，不能混为一条。缺少日期表边界时显示缺失，不循环借用。

## 固定结构

- `meta`：scenario/source_date/building_id/timezone/source_timezone/source_sha256/source_git_commit/config_sha256/generator_version/provider；tariff/rules/zones；floor_height_m/max_speed_m_s/acceleration_m_s2/motion；units/precision/connections。没有 notes。
- `hours[24]`：offset_ms/source_t/actual_kw/point_kw/outdoor_temp_c/hvac_setpoint_c/solar_w_m2/floors/environment/end_uses/energy/storage/pv/grid_kw/quality。
- `floors[40]`：floor/use/floor_kw/floor_actual_kw/occupancy_people/lighting_pct/fresh_air_m3_h/co2_ppm/fan_pct/mean_temp_c/zones[6]。
- `zones`：id/temp_c/fan_pct。顺序 north/northeast/west/east/southwest/south。
- `end_uses`：hvac_electric_estimate_kw/lighting_kw/plug_kw/elevator_kw/other_kw；合计 actual_kw。floor_actual_kw 合计 actual_kw；floor_kw 合计 point_kw。
- `environment`：people/co2_ppm/indoor_temp_c/outdoor_temp_c/relative_humidity_pct/pm25_ug_m3/humidity_basis。湿度采用露点与室温换算，空调开启限 40–65%。
- `energy`：hour_kwh/cumulative_start_kwh/cumulative_end_kwh/hour_cost_cny。每个电量对象含 actual_kwh/hvac_electric_estimate_kwh/lighting_kwh/plug_kwh/elevator_kwh/other_kwh。小时均值功率按一小时计电量。
- `elevators[6]`：id/zone/stops/initial_floor/capacity_people/seed_sha256/trips。
- `trips`：depart_ms/from_floor/to_floor/arrive_ms/dwell_ms/load_pct/passengers；停靠结束后保持终层至下一段。
- `alerts`：id/rule_id/offset_ms/level/system/asset_id/content/suggested_checks/status/resolved_offset_ms/work_order_id。
- `work_orders`：id/alert_id/offset_ms/system/content/suggested_checks/status/resolved_offset_ms。
- `agent_order_refs`：id/offset_ms/source_t/detail_index/suggested_checks；只关联既有工单。
- `history`：hours/source_date/source_sha256/agent_records/agent_records_quality。没有昨日 Agent 保存证据时 agent_records 为空，不编回执。历史 point_kw/storage/pv/grid_kw 可为 null。
- `summary`：energy_kwh/cost_cny。

功率、电量、温度保留一位小数；人数和 ppm 整数；百分数一位；新风量 m³/h；PM2.5 μg/m³；日照 W/m²。电价唯一来源是 `configs/agent_tools.json:tariff`，meta.tariff.periods/prices 按 24 小时提供。

位置插值使用 `src/ops/elevators.py::state_at` 的梯形加减速曲线，不累计页面运行时长。加速时间 min(v/a,sqrt(distance/a))，匀速时间 max(0,(distance-a*t_accel²)/v)，总时间 2*t_accel+t_cruise；将请求相对时间按段的整数毫秒时长映射到该曲线。三维和列表共用一次求值。

若文件原始超过 800000 bytes 或 gzip 超过 150000 bytes，脚本把楼层拆到 `{scenario}.ops-floors.json`，主文件 meta.floors_file/floors_sha256 提供引用。按 offset_ms 合并 floors；其余字段不变。当前 normal、peak 已拆，abstain 内联楼层。存在 meta.floors_file 时加载该文件并核对 floors_sha256；没有该字段时直接取 hours[].floors，不加载旧的楼层文件。

2026 使用已发布日期表；2027 明确为周末规则，policy 标记 pending，不声称调休已确认。

## 其他后端来源

整套 mockReplay 改读已有 `{scenario}.json` 或 `GET /replay/{scenario}`；mockWindow 改读该文件 hours[].forecast_24h/recent_actual。主数据版本为 1.5，前端需接受该版本，不再使用前端数值兜底。候选、选中项、理由取主导出 agent.candidate_summaries/selected/explanation 或既有 `/schedule` 的 candidates/selected/reason/selection_reason。问答取 `/chat/stream`，可回退 `/chat`，不可用时显示缺失，不本地造回答。本模块不修改 Agent 行为。

电梯高负荷服务按完成时间连续运行：07:30–09:30、17:30–19:00，区域人数不少于 900 时，返首层后按每位乘客 1.2 秒装客再出发，不按固定钟点等待；三台车首次进入该服务时错开约 17 秒。载客上限 20 人。按载客数及有人的服务楼层数分组，停站数为 min(2, 有人楼层数, max(1, ceil(载客数 / ceil(有人楼层数 / 2))))，繁忙线路覆盖区域最高有人楼层并按人数加权选其他站点。各楼层开门 6–8 秒，首层停留为开门时间与载客人数 × 1.2 秒的较大值；小时人数变化时，首层装客时间对应下一段载客数。早峰多层下客后空梯返首层；晚峰空梯上行、多层接客后下行。11:30–12:15 以载客下行为主，12:45–13:30 以载客上行为主，同样按完成时间连续服务；空载反向段用于接客或返回。其余时段及低人数日保持稀疏、人数相关的班次，零人数不发车。轨迹、字段和源日期种子不变，运行段载重不凭空变化。


## HTTP API

全部为 GET、只读，不修改 Agent 记录或下发设备指令。默认 building_id=Hog_office_Byron（唯一支持建筑），显示时区取 OPS_TIMEZONE，必须与已导出日期表一致。日期覆盖 2026–2027。所有输入时刻都是整数 Unix epoch 毫秒；窗为 [start_ms,end_ms)，时长 >0 且 ≤24 小时。数据响应使用同一 canonical JSON 编码，带 ETag 和 Cache-Control: no-cache；客户端仍可缓存文件，但使用前需复核版本。

| 路径 | 查询参数 | 返回字段 |
|---|---|---|
| /ops/time | 无 | schema_version、epoch_ms、timezone；Cache-Control: no-store |
| /ops/day | date=YYYY-MM-DD，building_id 可选 | 静态主 ops 的原结构；只替换 day_start_ms，不内联合并拆分楼层、不改 meta、不追加日期字段 |
| /ops/floors | date=YYYY-MM-DD，building_id 可选 | 与该日对应的静态楼层分文件逐字节一致；不绑定 day_start_ms。未拆分时返回 404，提示楼层已在 /ops/day 中 |
| /ops/window | start_ms、end_ms，building_id 可选 | schema_version、kind=window、timezone、start_ms、end_ms、days[] |
| /ops/history | 同 window | 同 window，kind=history；另外 agent_records=[]、agent_records_quality=unavailable，表示没有保存记录，不编造执行回执 |
| /ops/snapshot | at_ms，building_id 可选 | schema_version、kind=snapshot、at_ms、timezone、day_start_ms、meta、hour、elevators[]、alerts、work_orders、agent_order_refs |

window/history 的 days[] 按显示日期升序，各含 date、day_start_ms、meta、hours、elevators、alerts、work_orders、agent_order_refs。hours 保留与窗口相交的完整小时行，已合并楼层；其 offset_ms 仍相对各自日期零点，不挪成窗口起点。跨午夜分别按日期表加载前后两天，允许来源不同。窗口不会使用主文件 history.hours 来替代前一个显示日。

window/history 电梯保留窗口开始之前最后一条完整行程作为左锚点，以及窗口内开始的完整段。initial_floor 是第一条保留段的起始层，支持在窗口起点处直接求位置；段终点可能越过窗口边界，不裁成残缺运动曲线。事件仅取窗口内发生项；resolved_offset_ms 晚于窗口最后一毫秒时隐藏，状态保持待核查，不提前显示恢复。跨日 UI key 使用 date+id，显示编号不含日期。

snapshot.hour 是 at_ms 所在的完整小时行（数值不会每帧重新造）；elevators[] 是唯一轨迹求值结果，含 id、floor（连续层坐标）、target、status（up/down/doors/idle）、direction（-1/0/1）、load_pct。三维与列表应共用这一组结果。快照事件仅包含截至 at_ms 已发生项，未来恢复时间隐藏。

OPS_SOURCE=generated（默认）只读取现有 ops 主文件、必要时读取楼层分文件和日期表，不读取原始 CSV，也不运行生成器。共享只读字节缓存以文件路径、大小、mtime_ns 为键，最多 32 项；文件更新会失效，不会让请求修改缓存对象。

OPS_SOURCE=live 时通过 OPS_LIVE_FACTORY=package.module:factory 加载 OpsSource（src/ops/types.py）。工厂返回实现 read_day(key)、read_floors(key,meta)、connections(key) 的对象；key 包含 scenario/source_date/building_id。数据必须遵守同一固定契约并声明 meta.provider=live；工厂负责凭据和连接管理，凭据不放文件。工厂未配置、无法加载、读取失败、来源缺失或分文件校验失败均返回 503，不转为 generated。日期/范围/建筑输入错误返回 422。/ops/time 不依赖数据源或日期表，即使 live 未连接也返回服务器时间。

注册仅在 src/api/app.py 添加 router。现有常驻后端未重启；部署这些 API 需要服务维护方重启后端或重新加载应用。测试使用 TestClient 和临时 loopback 独立端口；退出时关闭测试进程与端口。


### 电梯 30 秒采样验收

运行只计 up/down，不计开门；区间为左闭右开。normal 08:00–09:30 每梯运行占比 55.6%–76.7%，平均同时 3.967 台；17:30–19:00 为 55.6%–76.7%、4.022 台。peak 对应为 62.2%–76.7%、4.161 台，以及 57.2%–73.9%、3.933 台。tests/ops 固定检查每梯 ≥50%、平均 ≥3 台，并保留确定性、连续性、速度、停靠及分项对账检查。


## 第 6 轮：已提交来源与告警连续时段

生成输入只读 Git：先固定 git rev-parse HEAD，再用 git show <commit>:exports/replay/{scenario}.json 读取主导出，日期表也取同一提交。不读取工作区主导出，也不修改 Git 或主导出。本轮输入提交为 a5c8ae057ce51c7293667d1d240b87783388c557。meta.source_git_commit 记录该主导出最后一次改动的提交（以固定读取 HEAD 为起点执行 git log -1 --format=%H <revision> -- exports/replay/{scenario}.json）；meta.source_sha256 对应 HEAD 主导出的原始字节。其余业务字段不变，live 适配器不强制提供 Git 提交字段。

--check 先断言当前 HEAD 主导出 SHA 与保存的 ops 一致，并核对各主导出的最后改动提交，再按固定 HEAD 重建逐字节比较；不同来源文件可以拥有不同的最后改动提交。这样后续只提交 ops 不会产生“输出提交必须包含自己的提交哈希”的循环；主导出真正变化时会明确要求重导出。测试也独立读取 git show HEAD 的字节核对 source_sha256。

室温基准仍是 27 °C，但设定 26–27 °C 本身不触发告警。每个楼层区域必须严格高于 max(27.5, 设定温度+0.5) °C，并有连续至少 2 小时的证据才触发；小时数据需要首条与两小时后共三条连续样本，不把单个瞬时高点视为持续。首次满足时才记事件 offset_ms，不提前两小时。缺小时证据报错，不跨缺口认定持续。

同规则的连续影响时段只生成一条告警与一张工单；楼层区域变化不刷新编号，全部区域回落后结束，之后新时段可再触发。content 写明触发当时已持续超标的区域名称、影响楼层数、区域类别数和楼层区域总数，不把未来扩大范围倒灌到过去快照。asset_id=building，编号仍不含日期。其他规则同样按规则连续时段合并。

本轮 normal、peak 各 2 条告警（室温 1、储能 1），abstain 1 条；没有为了数量目标增造告警。电梯占比、分项对账与静态/API 字节一致检查保持通过。本轮不改 API 注册，现有文件缓存按 mtime 自动失效，无需重启后端。


## r78 平峰更新

主数据读取 HEAD 的已提交主导出，各文件 source_git_commit 当前均为 58c7142eb88b6f3cad192afd71fcd0dbb8e4b802；它不是本轮 ops 导出提交。后续仅提交前端或 ops 不改变该来源标记。source_sha256 与 git show HEAD 主导出保持一致。

工作日在楼人数超过 1000 时，09:59 开始为 10:00–16:00 层间服务预备发车；三台梯按区域端点行程时间错开发车，间隔随日间区域人数变化，固定组内相位避免小时边界同时停梯。相邻班次运动有重叠，开门 7 秒，载客数随当前小时区域人数变化（上限 20）。会议层间行程不每轮返回首层，每五段兼顾外出返回及访客；午间两段保留载客下行/上行方向。夜间和节假日仍为稀疏服务。轨迹、限速、字段及编号结构不变。

30 秒采样 normal 10:00–16:00 平均同时运行 3.058 台，14:00–16:00 为 2.808 台；peak 分别为 3.074、2.796 台。两个窗口每个采样点低区/高区均至少 1 台运行（仅 up/down，不计开门）。测试同时核对在楼人数 1200、每区约 600 时也能启用层间服务，而不是误用单区 1000 门槛。

告警文案与严格阈值一致，例如“东区、西区 46 个区域（涉及 40 层）室温高于 27.5 °C 已持续 2 小时”，另注明相对设定温度的容差条件。本轮根据 r78 数据 normal 1 条、peak/abstain 0 条，不为条数下限制造告警。字段不变，不需重启后端，文件缓存更新后自动失效。
