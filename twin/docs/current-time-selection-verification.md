# 手动选时与回到当前：验证记录

## 后续补充：时间框与所选时刻一致

此补充替代下文首轮“时间框显示真实走钟”的行为描述：手动选时后，底栏和时间轴共用固定的显示时间；独立真实时钟仍更新，但不覆盖所选显示。日期在选时前从时间轴取得，跨真实午夜不改变，播放跨日后的格子按显示日期计算。返回当前恢复真实时间与秒级刷新；播放/暂停/结束仍沿用原帧时间。

构建通过；相关单测 29 项与全局状态分组 4 项通过；相关 e2e 25 项通过（24 项首跑通过，1 项首次未挂载 main 超时，单独复跑通过）。测试包括真实等待 4.1 秒时间框不变、小时与选中框一致、分数小时拖动、返回后走秒、真实午夜、播放跨日后选格、手机布局及原播放结束重置。

全量单测为 240 通过、4 失败：`agent-cost-window` 的 Agent 卡片文案断言、`agent-upper-labels` 的理由窗口字段断言，以及 `replay-1.4`、`state-data` 的根目录 1.5 导出/schema 同步断言；均涉及其他会话的 Agent/数据文件，本轮未修改。日志为 `.tools/agh-selected-clock-*`。

## 修改范围

- `src/state/store.ts`：手动选时关闭跟随，秒级走钟只刷新当前时间；显式返回恢复真实时间与跟随；3D 手动选时读取同一时间位置，播放仍读取连续帧。
- `src/components/BottomBar.tsx`、`DashboardShell.module.css`：时间框旁增加条件显示的“回到当前”，小屏可换行；桌面预留按钮位置，防止按下时间块后布局位移改变选时。完成播放的“↺ 重置”保持原行为。
- 新增状态/浏览器回归测试；更新 `e2e/timeline-input.spec.ts` 的真实时钟断言与紧凑布局测量，不再要求选时改写时钟。

## 验证结果

构建通过。时间/播放/订阅相关单测 28 项通过，`state-data.test.ts` 的全局状态分组 4 项通过（单独按分组运行，不修改/跳过原测试文件）。相关 e2e 共 25 项通过：共享机器负载下整组运行超时，已通过的 19 项保留记录，剩余播放与输入 6 项另起完整测试运行全部通过。

全文件 `state-data.test.ts` 另有 schema 同步断言失败：根 `contracts/replay.schema.json` 已被其他会话迁到 1.5，前端仍为 1.4，属于模型/前端契约未同步；不在本轮修改范围。

## 本轮覆盖

真实等待 4.1 秒后选时和 3D 均保持；按钮返回真实当前小时且时钟继续走；跨整点保留手动选择，恢复后跟随整点；320/390/1366/1920 宽度按钮无重叠、无横向溢出；点击、拖动与键盘选时覆盖 390/1280/1366/1600/1920；播放连续位置、跨日与原重置行为继续验证。

## 扩展 e2e 的逐项归因

以 HEAD `1648d35` 导出隔离副本，不替换共享工作区文件、不重启后端。依赖复用本机 node_modules，并仅为副本配置 Vite 字体目录访问；以下失败均不依赖本轮生产代码改动。

| 测试 | 结果与原因 |
| --- | --- |
| `timeline-input.spec.ts`：5 个尺寸 | 旧断言要求拖至 12 点后 `.clock` 显示 12 点，与真实时钟独立走钟要求冲突。已更新断言，并在按钮出现后重新量取小屏时间轴位置，5 项通过。 |
| `timeline-sync.spec.ts`：390 | 未改动 HEAD 也出现约 2–3 分钟几何偏差。冻结初始时间排除原选时被秒钟覆盖后，仍复现同类失败。旧测试用 cell 的 clientWidth（扣除边框）推算分钟，而连续 transform 用完整 slider 宽度，小屏误差更明显；本轮不改变这些几何规则。 |
| `scene-paused.spec.ts`：hidden overview stops render and projection RAF requests, resumes the same canvas | 未改动 HEAD 返回总览后同样得到 `data-render-active=false`，断在第 25 行；属于既有页面返回/活动状态问题，不是本轮选时逻辑引起。 |
| `mobile-shell.spec.ts`：compact shell, 24-cell touch timeline, scene first and content-sized verdict | 未改动 HEAD 在第 99 行等待已移除的 `.day-switch` 超时；旧测试未跟随去除日期切换控件的产品变更。 |
| `overview-stability.spec.ts`：24 hours x 3 days have invariant geometry and near-zero CLS 1920 | 未改动 HEAD 第 122 行等待已移除的“工作日”按钮超时，未进入几何采样断言。 |
| `overview-stability.spec.ts`：20 seconds playback samples every frame without main overflow 1920 | 未改动 HEAD 第 161 行等待已移除的“节假日”按钮超时，未进入播放采样断言。 |

旧控件的基线复测只在隔离副本缩短超时至 12 秒，不改变测试步骤/选择器/断言。日志保存在忽略目录 `.tools/agh-current-selection-baseline/`；本轮日志位于 `.tools/agh-current-selection-*`。

Agent 文案单测与前端/模型导出字节同步单测按会话职责不修改。不改预测、Agent、楼层、能源页面，不提交其他会话的改动。
