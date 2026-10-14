# 实时解释来源和千分位统一

## API给前端

`POST /schedule`顶层显式携带`explanation_source: "llm" | "template"`（与Replay的`hours[].agent.explanation_source`同名同语义）。`source`依旧是选案来源；真实LLM选案而正文用模板时必须`source=llm, explanation_source=template`。真实LLM措辞保留时为llm（允许宿主补上界/摘要）。规则回退、当前拒绝、demo均为template。

检查发现上一版run_agent已经返回此字段，API的`**result`理论上会携带；本次API响应显式映射并用HTTP测试锁住五条路径：真实LLM措辞、真实LLM选案模板措辞、grounding回退、demo、当前拒绝。没有假称已验证常驻线上进程；线上缺字段/仍有千瓦可能为常驻旧代码，必须重启scripts.serve_backend。未接管现有服务。

## 千分位

公共文本数字绝对值达到1000分组三位，保留正负号/原小数精度，不再浮点舍入：`1,352.6 kW`、`16,554.8 元`、`-1,234,567.00 kWh`；单位一个空格，百分号不空格。今天/次日HH:MM格式不变。

合法千分位去逗号后提取numeric tokens，单位不参与数值匹配；grounding阈值1e-7和真实工具数值不变。`99,999.9`作为完整99999.9校验，不能用99/999.9片段蒙混。错误分组如12,34或1,,352拒绝，不盲删逗号。chat的required_values检查共用相同token解析，防止有效大数被拆成片段误回退。调度和聊天prompt均规定千分位，最终渲染再规范。

## 三天重导出

`python -m scripts.refresh_display_text`完成离线文字重导出：normal923、peak879、abstain721个字段改为千分位，sample无变化。更新SHA及两份导出回执，新receipt为grouped_display_refresh.json，不覆盖上轮display_text_refresh.json证据。零LLM新调用、零指令新下发；测试去掉合法千分位后整份JSON与773db56严格一致，包含控制、温度、SOC、grid、经济值、选案来源及措辞来源。导出分类仍normal12/12/0、peak14/7/3、abstain12/0/12（llm措辞/template措辞且llm选案/rule）。1.4schema无变化。

## 验证

全套后端pytest249通过，1个既有Starlette/httpx warning；新增30测试覆盖合法/负数/边界/错误分组、整值grounding、不支持大数chat与SSE回退、七类问题demo/真实provider桩、schedule五种来源、嵌套摘要和plan、72导出字段及幂等刷新。没有在测试里调用真实provider。运行凭据原字节扫描和暂存秘密检查后只提交本项文件；未动twin。前端同步这次新导出即可消费原1.4字段语义。
