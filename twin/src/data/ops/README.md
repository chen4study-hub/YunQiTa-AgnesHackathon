# 公共 ops 加载层

仅包含加载、日历时间、校时、电梯求值；不修改页面、共享 data 契约或导出文件。

## B / 3D 接入

```ts
import {
  createOpsLoader,
  createOpsClock,
  evaluateOpsSnapshot,
} from "./data/ops";

// 同一应用共用实例，不要在每帧创建或请求。
const ops = createOpsLoader(); // /replay/ops-calendar.json → {scenario}.ops.json
const clock = createOpsClock(); // /api/ops/time；失败或 2.5 秒超时用本机
const status = await clock.sync(); // {source, offset_ms, timezone, error?}
let day = await ops.loadAt(clock.now());

// 每帧只做纯函数求值，把同一结果交给楼层列表与 3D。
const at = clock.now();
if (at < day.day_start_ms || at >= day.day_start_ms + 86_400_000) {
  day = await ops.loadAt(at); // 午夜换真实日历日期；不要 %24
}
const snapshot = evaluateOpsSnapshot(day, at);
// snapshot.hour: 当前完整小时，含 floors/environment/energy 等
// snapshot.elevators: id/floor(连续层坐标)/target/status/direction/load_pct
```

上例 import 路径按调用文件相对位置调整。历史选时同样传绝对 epoch 毫秒，而非小时索引：

```ts
const day = await ops.loadDay("2026-10-12");
const at = day.day_start_ms + 18 * 3_600_000 + 31 * 60_000;
const snapshot = evaluateOpsSnapshot(day, at);
const window = await ops.loadWindow(at - 6 * 3_600_000, at);
```

- `loadWindow(start,end)` 为左闭右开，最多 24 小时。`hours` 按绝对时间拼相邻日历日期，每行 `{date,scenario,at_ms,end_ms,hour}`，保留与窗口相交的完整小时。
- `window.days` 为完整日期绑定数据，含电梯轨迹、告警和工单；事件绝对时间 = `data.day_start_ms + event.offset_ms`，筛选用 `start <= t && t < end`，组件 key 用 `date + id`。完整 days 的事件没有预先筛选。
- `day.history.hours` 是来源日期的历史，不是显示日期昨日；昨日列表应调用 `loadWindow`。
- 日历边界/文件缺失/数据不匹配均抛错，调用方显示缺失，不循环借用或造数据。
- meta 有 `floors_file` 时按原始响应字节核对 SHA-256，再按 offset 合并当天和 history 楼层；没有时只用内联楼层，不请求旧分文件。Web Crypto 要求安全上下文（HTTPS 或 localhost）。
- loader 合并并发请求、缓存成功模板；每次返回独立副本，失败可重试。更新导出文件后显式 `ops.clearCache()`。逐帧不要调用 loadAt；仅在日期切换时加载。
- `clock.sync()` 去重并发、无后台定时器；重连后可再调用。后端时间按 RTT 中点锚定，此后用单调时钟推进；`getStatus()` 返回来源。校时不等于设备已连接。
- `evaluateElevator(lift,meta,day_start_ms,at_ms)` 可单车求值。出发前保持初始/上一终层；运行使用 meta 梯形或三角加减速（`t_acc=min(v/a,sqrt(d/a))`），曲线映射至导出的整数毫秒行程；到达即 doors，dwell 结束即 idle 或下一段，全部左闭右开，不累计帧步长。
- 可注入 `{baseUrl,fetch}` 至 loader，`{fetch,timeUrl,timeoutMs}` 至 clock；数据默认仍从静态文件加载，后端只用于校时。

## 当前部署前提

本次检查 `exports/replay` 已有全部 ops 文件，`twin/public/replay` 尚无 ops 文件。该目录与 sync 归 A；请 A 同步 `ops-calendar.json`、三个 `.ops.json` 以及 normal/peak `.ops-floors.json` 后使用默认 URL。本层不改或自动复制这些文件。

## 验证

从 `twin/` 运行：

```text
node node_modules/vitest/vitest.mjs run --config src/data/ops/vitest.config.ts
npm run build
```

单测 fetch 读取根目录 `exports/replay` 的真实文件，覆盖三个数据分支、原始字节哈希、合并、并发隔离、跨午夜/边界及完整导出电梯轨迹。默认 Vitest 配置仅发现 tests/，故本目录提供独立 scoped 配置，不改共享配置。无需启动或重启后端。
