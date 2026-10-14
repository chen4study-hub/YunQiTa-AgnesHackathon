# 实现决策 · 2026-10-11

## 看板重建
- 参考仅采用 reference/screens 的八张图与细节图，以及压缩包 02/04；旧说明废止。
- 固定 Vite 8.3.4、Vitest 5.0.3，避免旧测试依赖已披露的 critical 漏洞。构建工具的 lightningcss 1.33.0 使用 MPL-2.0：作为开发期转换器的明确许可证例外，不在页面执行；许可证审计逐项记录该例外，其余未知许可证仍失败。
- 按用户要求固定 ECharts 5.6.0；npm audit 报告 GHSA-fgmj-fm8m-jvvx（moderate，修复需升级 6.1.0）。图表禁用 HTML tooltip，使用 richText；不接受外部 HTML formatter。未声称漏洞已经消除。
- 字体使用本地 @fontsource Barlow Semi Condensed / JetBrains Mono 5.3.0，不请求 Google Fonts。
- 演示操作只改变前端演示状态；真实设备下发、LLM 在线、回执不得凭空宣称。后端现有 shadow/rule 能力与参考图有差距，记录在 PROGRESS。

## 原3D实现记录

- 仅修改 twin；参考文件及原 prompt 保留于 reference，根契约复制为只读校验快照。后端源数据不改写。
- Vite + TypeScript + three.js，核心与 DOM 外壳、数据源分离。Three 0.170.0 固定；Vite 8.3.4 / Vitest 5.0.3 替换旧版本，npm audit 0 vulnerabilities。
- 每层独立 Group，圆角平面收分扭转，幕墙竖框每层合并。城市和行道树实例化；物体/材质在创建阶段预建。
- ACES 最后 ShaderPass，renderer NoToneMapping，不额外 gamma pass；夜间环境反射降低。使用近似太阳时刻曲线，不声称精确地理天文模拟。
- 只有整栋 abstain 驱动塔冠与整栋轮廓报警，楼层绝无单独拒绝状态。园区按建筑自身拒绝着色。
- 默认真实 replay 文件；明确失败后才退回 mock。同步发现后端三剧本已存在，故 public/replay 放真实文件，public/mock 单独保留三套模拟文件，避免静默混合。
- 数据 timestamp 按记录小时显示，不做浏览器时区转换；模拟 timestamp 用 Z 通过契约 date-time 验证。
- 网页只呈现历史预测与影子方案，不连接设备。confidence 不作为单小时正确概率。
- 本机未在 PATH 找到 Node，但发现已有 Codex Node 24.21；临时 npm 工具只放 twin/.tools，不修改系统 PATH。测试构建均实际运行。
- 可视回归使用已有 Playwright + Edge：浏览器无 pageerror；20次生命周期资源归零。截图文件已生成，但桌面工具超时，尚未完成直接视觉审查；不宣称达到50fps。
