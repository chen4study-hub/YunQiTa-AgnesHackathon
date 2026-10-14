# 对外单位、日期与禁词修复

## 规则与边界

公共文本集中在src/agent/display_text.py处理，并写入调度/聊天prompt：数字后一个空格再接kW、kWh、元、°C；百分号紧贴数字，如89.3%。千瓦时先于千瓦匹配，不舍入、不改数字大小。英文单位从禁止英文字母规则中精确豁免，其他内部英文字段/动作规则不放宽。

时间统一为今天HH:MM或次日HH:MM（日期词后一个空格），根据起报时区及已发布timestamp计算，不按服务器日期。完整原日期只有匹配实际工具timestamp才转换；缺日期、矛盾日期或来源外时刻不猜，聊天重试/回退，调度模板兜底。机器timestamp/t/origin、模型来源年月不改为2026，不增字段、不改变1.4结构。数字grounding匹配函数原样保留；新增私有clock证据由已有timestamp派生hour/minute（不加入公开契约），使HH:MM可以按真实工具数字核验。单位规范不改变任何数字token；无来源99999等经后处理仍失败。verified calendar仅移除经核验的年月日文本，不许可新成本/功率。

禁词仅处理用户看得到的措辞：保留电量等值班人员复核后使用；推算、线性情景、非实测、逐时记录等替代。保留情景/不代表实测、接受与排除时段、非全天等限制，不把计算数据当测量数据。字段名/内部元数据/历史实验报告/许可证不做抹除。全部后端exports用户可见键（title/display_name/explanation/summary/reason/actions/工单数组/label）扫禁词，并对JSON聊天、SSE拼接答案、schedule的理由/plan/工单及72小时导出加锁。SSE工具参数的机器origin仍2017，这是证据不展示文本。

## 导出（离线文字刷新）

执行python -m scripts.refresh_display_text，normal/peak/abstain全部重写对外解释、候选摘要、逐步reason和工单文字，sample的标签同步处理。零新增LLM调用、零下发，测试按aef89d8逐字段恢复文字后严格比较数据，所有控制/功率/SOC/grid/目标/经济值与source均不变。3条旧LLM解释有无法确定哪一天的裸中文钟点，改成宿主摘要，并如实explanation_source=template；其他有明确今天/次日的中文钟点统一格式。

|场景|LLM措辞且LLM选案|模板措辞且LLM选案|rule|
|---|---:|---:|---:|
|normal|12|12|0|
|peak|14|7|3|
|abstain|12|0|12|

source=llm总数仍24/21/12。单纯字段template（含规则）为12/10/12。不重跑13天，不把措辞变化宣称成控制收益或provider成功率变化。receipt和SHA更新。

空调占比可见label从旧禁词换成“空调电耗占比（推算，非实测）”，model_card同更新。根1.4schema的label常量随之变更，其余结构不变。冻结2016热工代码字节、开发验证与参数都未修改；export封装覆盖旧生成标签，避免污染模型冻结证据。

**前端交接**：同步根contracts/replay.schema.json中的energy_summary.label常量；旧前端本地常量仍旧值，会拒绝新导出。未修改twin/，也未替前端验收。agent.explanation_source语义不变，模板替换的3条已准确标注。

完整pytest219通过，1个既有Starlette/httpx弃用warning；其中新增38个展示/协议用例覆盖demo与真实provider桩、chat/stream全工具、源日期转换与越界拒绝、规范单位、禁词、grounding和控制保留。零真实provider重试用于本轮验收。凭据原字节+暂存秘密扫描后只提交本轮文件。常驻scripts.serve_backend未接管，需重启加载代码。
