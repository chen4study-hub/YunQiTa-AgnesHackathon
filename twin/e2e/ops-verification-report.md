# Ops / shell 定向验收记录

## 范围与证据

- 运行：Edge、端口5191、单worker；未启动/重启后端，未修改产品，未构建到 `twin/dist`。
- 当前 floors-energy 清单：28个spec、93例。完整分批运行后，对修复/后续提交涉及项定向复跑；按测试完整标题合并最新已完成结果：**89通过、3失败、1既有fixme跳过，无遗漏**。
- 这是持续变动工作树的累计验收，不是冻结提交上的全组一次通过；175秒预算未执行项不计为通过或跳过，已补齐。
- 机器明细：`%TEMP%\agnes-postcommits-b9011a5e\coverage.json`，包含93例、状态及各自原始报告路径。
- 分批原报告：`%TEMP%\agnes-ops-verified-b9011a5e\groups-*\floors-energy\report.json`。
- 最新指定提交复跑：`%TEMP%\agnes-postcommits-b9011a5e\floors-1.json`、`floors-2.json`、`closing.json`、`shell-canvas-repair.json`。预算中止项以最后完整复跑为准。
- 该跳过项是 `floors.spec.ts` 的390px跨页壳层fixme，不是新跳过。

## 指定提交复核

| 提交/用例                                             | 结论                              | 实测                                                                                                             |
| ----------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| f6bdfd7 后 floors、负荷条、井、设备指标及viewport-fit | 相关完整复跑通过；温度刻度3例除外 | 40条负荷、6井、设备层Ops指标及绝对时间/刷新/3D误差≤0.05层检查通过                                                |
| 1366温度绘图区 `floor-temperature-height.spec.ts`     | 通过，140px阈值保留               | 宿主217px，实际绘图区141px；1920绘图区261px；22/2/39F均检查                                                      |
| 5d76269 后 `floor-colors.spec.ts`                     | 6/6通过                           | normal分位21.1/27.4/34.660000000000004，peak22.5/29.4/36.96，abstain18.540000000000003/23.4/28.4；3D和楼层页一致 |
| 8181b77 后 `energy-next-day.spec.ts`                  | 2/2通过                           | 22:30跨午夜，日期/绝对窗口/时间点及实例ID保持检查通过                                                            |
| 1366告警表头首屏                                      | 通过，要求未删除                  | top588.78125、bottom622.28125，首屏限底624.171875；14点、normal/abstain23点均通过                                |
| SOC/%                                                 | 通过                              | 5尺寸SOC数值、弧端点及数字与%间距≤1px保持；未降低字号躲避几何检查                                                |

## 当前3条产品红例：均归 B3

共同spec：`floor-temperature-cards.spec.ts:98`。
共同步骤：设对应viewport（1366×768、1600×830、1280×664）→ `/?source=file&at=2026-07-23T14:00` → 楼层与电梯 → 等字体/6分区卡片 → 对比27℃刻度中心与 `.floors-temperature-limit` 中心。

| 用例                   |   水平差实测 | 要求 | 判定/会话            |
| ---------------------- | -----------: | ---: | -------------------- |
| 1366 temperature cards | 36.1484375px | <3px | 限值语义标记错位，B3 |
| 1600 temperature cards | 42.5546875px | <3px | 限值语义标记错位，B3 |
| 1280 temperature cards | 33.7890625px | <3px | 限值语义标记错位，B3 |

字体均达到md下限、数字/单位同一行且在卡片内；不是字号偏差。1920与390同项通过。源码中桌面窄尺寸把刻度改为flex均布，27℃中点不再对应温度带的5/6处；保留语义对齐断言，不改产品。

## 先前红例逐条处置

| spec / 红例                                                      | 最终处置                                                                                   | 归属                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| floor-colors 390/1366/1920及normal/peak/abstain共6例             | Ops就绪后再读快照；5d76269后全过，旧3D分位产品问题已修                                     | 主看板，已关闭          |
| energy-next-day 午夜实例重建                                     | 保留实例稳定性断言；8181b77后通过                                                          | B3，已关闭              |
| compact-pages floors1366：裁切/固定60px温度显示/固定120px井高    | 裁切随产品修复关闭；固定高度不是可读性要求，改实际容纳、边界和字号下限；复跑通过           | 测试过时，已修          |
| compact-pages energy1920：23点无data-time                        | 后续完整复跑通过，旧一次加载失败未再现；不认定新产品缺陷                                   | 未复现                  |
| floor-energy-scrollall1366：禁止52px必要纵滚                     | 改共享滚动策略，保留横溢/假滚动/真正裁切；四尺寸0/10/14/23点通过                           | 测试过时，已修          |
| floor-energy-layout-budget原1366裁切；后4尺寸加载失败及高区井0例 | B3布局修复及数据版本一致后通过；文件不是本会话修改/提交                                    | B3/并发数据更新，已关闭 |
| floor-energy-ops两尺寸3D未就绪、午夜、retry共4例                 | export fixture同时提供匹配manifest SHA，路由按pathname匹配?v=；4/4通过                     | 测试fixture，已修       |
| floor-energy-readable-fonts1366                                  | 布局修复后四尺寸完整复跑通过                                                               | B3，已关闭              |
| floor-gauge-fit1920/1366/390                                     | md是下限；同一行按文本fragment相交判断，不把单位不同字号的顶边当换行；3/3通过              | 测试过时/检测错误，已修 |
| floor-temperature-cards最初五尺寸字号/后来换行红                 | md下限、卡内宽度及真实文字同一行检查；不再要求固定28px/等于md；剩3例仅刻度错位             | 字号红已撤回；3例B3     |
| floor-temperature-height1366                                     | 删除无依据200px宿主高度代理，保留真实绘图区≥140px；4204565后141px通过                      | B3，已关闭              |
| floor-equipment超温fixture                                       | 修改后的sidecar、主文件引用SHA、manifest SHA一致，pathname匹配；复跑通过                   | 测试fixture，已修       |
| mobile-pages energy390图例2列                                    | 单列是当前内容型布局，查每行在卡内且不裁切；两页通过                                       | 测试过时，已修          |
| elevator-no-stop高区遮罩                                         | 用导出ID定位，时间用day_start_ms+offset；三高区遮罩可见、有纹理、轿厢层级在上，Ops停靠合法 | 通过，无缺遮罩产品回归  |

## shell-time 定向结论

| spec / 用例                                           | 步骤与实测                                                                                                          | 判定/归属                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| replay-1.4 / presentation-metadata / rolling-playback | 1.5版本、真实总览small、About build容器、日期标签/24cell、pathname请求匹配；13/13过                                 | 过时断言已修                             |
| tab-time-sync playing clock                           | 两页打开About→播放→20次50ms采样；最大4显示秒≤360秒；timeline-sync两尺寸也过                                         | 原1368秒未复现，不报产品                 |
| mobile-footer-inset                                   | About最后卡必须在footer上方；改滚动实际卡而非window；footer原121.59375px→140px→恢复均过                             | 测试滚错容器，已修                       |
| mobile-shell compact verdict                          | 390×844，10点选时；卡高680px、body224.046875px、末段至卡底416.953125px，要求<25px                                   | 真实多余空白，归主看板；产品未改         |
| frame file/mock/api                                   | 3来源→透视/展开→切Agent→播放/暂停→3尺寸resize；3/3过                                                                | 原canvas缺失未复现                       |
| timeline-input五尺寸                                  | 原pauseAt冻结延迟0ms初始化；改只固定Date、保留定时器；点击/连续拖动/键盘及canvas五例过                              | 测试时钟错误，已修                       |
| timeline-color                                        | 旧日按钮已移除，改at路由；播放语义中心像素断言保留，通过                                                            | 过时日切换已修                           |
| current-time-selection                                | 真实秒及模拟午夜/四尺寸共6例过                                                                                      | 原加载/导航问题未复现                    |
| data-contract15                                       | ?v=漏拦截修为pathname；主文件失败/retry两尺寸过；companion身份破坏测试隔离device cache，5/5过                       | 测试fixture/过时日期已修；Agent UI未修改 |
| lazy-page-loading                                     | Forecast/Agent/Floors/Energy通过；About注入延迟实测899.9956<900是Node定时器微早触发；改循环确保真的注入900ms，6/6过 | 测试注入错误，已修；warm阈值仍750ms      |

shell以上证据在同一TEMP根的 `shell-canvas*.json`、`shell-timeouts*.json`、`contract15-final.json`；时钟在 `%TEMP%\agnes-shell-repair-b9011a5e-clock.json`。未把定向结果冒充shell全组冻结验收。

## 其他验证及仍开放

- 自己改动的Prettier和 `git diff --check` 通过。runner当前工作树149spec唯一归组；提交后的e2e归档在无.git、无node_modules、PATH仅Node时 `--list` 验证147spec唯一归组。归档内容较少是其他会话尚未提交的新spec，不是漏分组。
- 工程自带Vitest实际运行：352/365通过、13失败（7/95文件失败），未改这些单测。主要有旧1.4断言、缺arrayBuffer的fetch mock、模型导出与public不同步，另有Agent文案/上界展示/API请求表变化、energy CSS作用域检查；这批是额外暴露的单测项，不能仅凭本次输出判为产品缺陷。由主看板/A/B3/模型各自检查其相关单测，不混入本次提交。
- forecast-agent剩余整组未完成；性能需空闲机复核。用户指定冻结全量仍留给其他机器，本机未全量。
- 本会话临时诊断spec已删除，自己的5191没有监听；分组runner逐批确认自身Vite/Edge退出，未停止他人进程。

## 已提交并立即push

`043fd8c`（Ops/字号下限与6spec收尾）、`6128ad9`（响应式井/真实日期）、`0c4705c`（timeline时钟/移除日按钮）、`a4aa4e2`（contract fixture/精确冷延迟）。均使用精确文件列表，无force、未提交产品或他人dirty文件。
