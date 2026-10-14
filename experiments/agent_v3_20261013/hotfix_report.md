# 线上优先热修：已有结果兜底与储能追问

**需要重启。CHAT_AGENT_LOOP代码默认关不改；线上开关由部署控制。**

根因：tariff_periods真实trace start_time/end_time没有纳入可信时钟，validate_answer把13:00/17:00/18:00判成无依据，template_records因为一个坏句丢掉整个参考答。修复工具区间/下一档时钟识别，未知时钟仍拒。所有本楼工具参考句逐句校验，保留通过的句子，不因别句失败清空；只选本问题所需工具，避免模型多查get_time/current_state污染兜底。已有可用参考答遇首响应超时立即用工具结果，不额外重试10秒；仍mode=fallback、explanation_source=template，reason=answered，llm_reason保留真实失败。不冒充模型正文。

短追问“那放电呢？”只从最近用户的今日累计储能意图继承范围，不读取assistant里的数字。重新查本轮storage_history；显式当前/历史日期不改，不跨无关问答继承。累计充/放电参考答只写所问电量及截至时钟，不附SOC、当前功率或另一方向。工具仍只读。

数值核对：normal.ops.json原始已结束小时，14:00充电802.4、放电750.0 kWh；19:00/19:30充电802.4、放电1,171.7 kWh。报告14:00与线上19:30范围不同，两值都正确。19:30不含未结束19:00–20:00，非实时积分或未来全天。没有改ops数据/导出/计算公式。

验证：82相关单测通过8.32秒，包括15类本楼读工具provider失败后仍有answer、未知时钟负例、短追问重新查工具、无关/昨日/显式当前不继承、坏句不丢好句、无结果仍只一次重试。先跑旧断言1失败，更新已有结果不重试的行为测试后全通过。

单独端口/tempDB真实API验收4问（两批各2问；单进程顺序，CIM无probe遗留，owned_backend_stopped/background_classifiers_stopped均true）：
- 下午哪个时段电费最贵：15.156秒，mode=llm，13:00–14:00/1,518.8 元/1.20 元/kWh正确，无失败。
- 今天储能一共充电：1.312秒，802.4 kWh。
- 同会话充电→“那放电呢”：2.719/1.969秒，802.4/1,171.7 kWh，第二问仅storage_history，无get_time/more_tools/current_state，无SOC混入。
自动4/4，人工读4答及trace符合本次问题。线上没有恰好发生provider超时，兜底故障分支由真实工具+注入失败单测证明，不能说线上已测超时分支。电价15秒仍偏慢，留下一阶段超时优化，不把本热修说成性能验收。

只提交本人agent_runner/answer_grounding/building_tools/storage_scope、测试和本热修材料。未改app.py、web_search.py、chat_router.py、general_chat.py；这些已有其它会话更改不会提交。独立验收读取共享工作区当前依赖（源码哈希收据保存），不等同干净部署环境。未碰常驻后端/其它目录，无key落盘。下一阶段单独修四类评分不对称及10组多轮，原round4结果不覆盖。
