# v3 原生循环（默认关闭）

环境变量 `CHAT_AGENT_LOOP` 默认未设置/关闭；`1/true/yes/on`开启。环境在请求开始选择provider和管线；更改服务启动环境需重启，不在页面或HTTP接口提供切换，不更改生产模型配置。关闭维持v2链路。开启不代表已通过验收。

`/chat`、`/chat/stream`原字段保留，新增可选：history（最多16条、role仅user/assistant、content 1–4000字）、context_id（32位小写十六进制）。session_id仍原样透传。trusted context仅进程内30分钟/256项，按楼宇、场景、数据起点、显示日期时间、session隔离；历史文本不是数字证据。重启后重新查询。

事件名称及旧字段不变：step/tool_start/tool_end/answer_delta/progress/done/error。新循环工具事件用tool_start(tool,args)及tool_end(tool,ms,summary)，增加id/name仅为附加字段；more_tools是目录展开、无数据查询，不伪装成设备调用。progress id仍chat-answer-wait，首个非空answer_delta前每秒文字“已等待 N 秒”，覆盖分类、工具与模型阶段，首字后停止；两条链路由响应层同一时钟去重。最终文本先校验再逐句发出；首步过渡模型文字不直接发给前端、不算回答。done增加context_id/agent_loop，保留mode和reason；不将配置为real等同mode=llm。

工具默认六个常用＋more_tools，主机按问题预展开相关类别。首次调用模型前复用现有fast_choices/intent/范围判定，最多3个本楼只读工具并行查询，成功及失败记录放入首轮上下文，保留tool_start/tool_end；模型证据足够直接答，不足自行补。非本楼工具只预展开，不提前联网，仍在tool_start分类none后执行。类别为alerts/elevators/energy/internet/storage/building/operations/forecast。未预展开的类别仍用元工具展开后下一请求可调用。全目录22项（含元工具及新增tariff_periods），不删现有功能。只读，不改设备/提交接管。

期限：整循环25秒，预留0.6秒取消/join/已得证据校验和最终SSE，决策预算24.4秒；每个请求首实质content或tool-call delta10秒（空role delta不算）；一次无首token超时重试，复用整轮剩余预算、不与旧请求重叠。工具返回后的下一模型步骤完整请求上限10秒，不因重试重置该步骤期限，超过总期限不得新开工具。公开源工具已有8秒上限继续保留。分类守卫独立20秒、并行：本楼数据可先查但结果缓存；联网/城市天气执行前必须分类none。循环25秒从管线开始计，分类等待占循环剩余预算。

质量：当前天气强制current单时刻；当前SOC/电池剩余量使用current_state，不把历史充放电或0–1比例当百分比；HVAC必须列所有未计入本地时刻及理由和“不按整天”。楼宇数字逐句校验，一次重写仍不合格不发模型文字，只回已有工具的校验模板（mode=fallback），无可用证据则非空“这次未能取得可用的查询结果，请稍后再试。”、known=false/reason=no_data。已有成功工具的reference经数字/来源校验后用于到期回答，mode=fallback，不冒充模型成功或达标。公共来源不能填本楼读数，链接仅允许真实查询结果URL。v3联网适配器按原问题的城市+主题检查标题或真实正文lead，不以RSS片段关键词巧合命中放行，不以日期/URL命中当相关，丢掉不相关sources并重建回答；全丢则没查到相关报道。最终中文文字对已知工具/字段/策略标识用中文别名，未知snake_case和过渡句拒绝并重写，URL及BA/EMS保留。第三轮累计储能按今天/累计/一共走storage_history，当前SOC/剩余走current_state；当前功率走current_energy。think完整段及流式分片段在answer_delta前剔除，回执条/ms/毫秒前加空格。无相关报道只给“没查到相关报道。”不串天气来源。该过滤不保证完整语义理解。mode按最终正文来源：验证模型=llm，模板或未完成=fallback。

旧 `contracts/chat-agent-stream.md` 是失败草稿，tool_call/tool_result/30秒/8秒部分不适用于当前v3实现。最终验收标准（用户更新）：完整91题及10组多轮质量不低于旧链路、不能用模板替代回答、话题守卫继续生效；中位数约15秒，每题整轮25秒内非空回答，不能卡死。原15秒内>90%不再是硬门槛。2026-10-13验收未通过：回归含模板44/91 vs旧链路82/91；v3不含模板23/91、空答26、>25秒12。默认继续关闭，完整证据见 experiments/agent_v3_20261013/report.md。后续仅重跑原失败47题，断点三版本收据合计16/47断言通过、8/47模型通过、空答0、>25秒0；没有重跑原成功44题，不构成全量新验收通过，见v3_fix_report.md。本轮同一冻结版本验收剩31题+此前通过15题，自动36/46，模型31/46；中位8.203秒/P90 18.937秒，空答0/>25秒0；人工发现假阳性，不宣布上线，见round2_report.md。第三轮四项修复99相关单测通过；完整对比中断于off第66题评分器record形状错误，on已91+10组、off仅前65题。原始自动83/91对44/65不公平，不能宣布通过；具体见round3_report.md。当前代码含中断后类型防护修复，不再等于第三轮原manifest，重新验收须新冻结，两边全部重跑。

第四轮运行前修复：分日日期与数值绑定检查、人数千分位、次日峰值标签及低把握提醒、恰好两句、共享呈现压缩同日标签并保留次日范围。台风当前工具不提供因果影响评估，不能用晴雨/无报道推断有无影响，给出真实工具参考及无依据说明（模板，不计模型回答）。LLM_MODE=demo时两边走确定性工具模板；无支持功能直接“这个问题超出了看板能回答的范围。”、reason=out_of_scope、llm_called=false，不能冒称超时。原始数字支持来自trace而非参考句/display_values；公共概念与楼宇读数分开。第四轮同版本完整对比见round4_report.md（完成前不宣布通过）。

需要重启。
