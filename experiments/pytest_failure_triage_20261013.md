# pytest 失败分诊（2026-10-13）

用户报告：干净克隆（d0b18c4 之后）899 过、32 挂。本轮没有原始 32 条完整 traceback，因此不把按文件列出的测试自动当作原失败 nodeid。以下区分实际复现、验证通过及尚缺原始异常的条目。

范围：仅修改本会话的开放问答代码和两个测试文件；不修改 tests/db、src/db、migrations、takeover.py、规划器、twin、Ops、导出或冻结证据。没有新增 skip，没有放宽阈值。按用户要求不处理既定峰值参考文本句子门用例。

## 行为类逐条结论

| 文件 / 用例 | 分类 | 实证与处理 |
|---|---|---|
| tests/db/test_cancellation_decision.py::test_create_cancel_restores_export_decision_and_no_current_work_orders | 环境：测试时钟隔离缺陷 | 撤销后 auto/executed、plan 恢复导出、无当前工单、聊天解除人工状态等断言全部通过；只在第75行审计动作失败，实际 create/expire/cancel。standalone.create_app(clock=固定03:02) 注入的时钟仅供接口服务；get_active_takeover 创建 Repository(Database()) 时使用真实09点时钟，因此调度查询使该凌晨记录过期。 |
| tests/db/test_cancellation_decision.py::test_cancel_then_recreate_same_hour_selects_new_manual | 环境：同一时钟隔离缺陷 | 新接管ID、24.8 °C、manual 和当前无工单全部通过；只在第143行历史状态失败：新记录 expired 而非 active。不是4bf95c9锁定决策导致。 |
| tests/test_open_conversation.py::test_general_numbers_not_checked_against_building[你好] | 真问题 | 以下六条共有mock返回常识数字1900/50%和无数字“本楼真实数据需查询工具”，旧数字保护将提示误识别为测量，整句拦截。修复提示识别，不更新六条断言。 |
| 同用例[什么是光合作用] | 真问题 | 同上；修复后通过。 |
| 同用例[解释一下复利] | 真问题 | 同上；修复后通过。 |
| 同用例[楼宇运维基础知识] | 真问题 | 同上；修复后通过。 |
| 同用例[电梯工作原理] | 真问题 | 同上；修复后通过。 |
| 同用例[电池SOC是什么意思] | 真问题 | 同上；修复后通过。 |
| tests/test_open_conversation.py::test_explicit_web_bypasses_operation_keyword_false_positive | 真问题：同一误拦截 | 已正确走web_search，来源去重正确；mock数字回答被拦而转template。修复后llm断言通过。 |
| tests/test_open_conversation.py::test_failed_web_not_scope_refusal | 真问题：同一误拦截 | 路由本已正确走公开常识fallback，不是out_of_scope；mock回答因相同提示误拦而known=False。修复后保留“常识整理”及50%。 |
| tests/test_chat_operator_updates.py::test_selection_prompt_omits_internal_policy_but_trace_keeps_it | 旧断言 | public_text在repair_prose阶段已整句删“遵循峰值容差，电费较低。”，实际诊断prose_repair_failed。更新单个预期码，仍严格要求空输出与唯一诊断计数。工具trace保留policy，模型证据不公开policy的断言不变。 |

### 数据库会话应处理的测试建议（本轮未编辑）

在该文件给调度/聊天调用的默认Repository也注入同一测试时钟。例如第一条固定时钟；第二条使用`lambda: clock[0]`同步随测试推进。实际验证命令在进程内临时设置`src.db.repository.utc_now=lambda: datetime(2026,10,13,3,2,tzinfo=ZONE)`，不编辑任何文件，文件3/3通过。更严格的第二条应使用共享clock列表。不要把额外expire或expired改成合法预期，不要删除审计/历史断言。

### 问答修复边界

仅排除独立、无数字、明确要求查询工具的本楼数据提示；不允许任何数字型本楼声明通过。保持本楼实际读数问题必须工具验证，空证据拒绝。新增8例覆盖JSON/SSE、显式联网与联网失败，以及分号/逗号后的本楼功率、数字型“提示”和直接楼宇问句防漏。原8条断言不变。


## 研究、复现与其他条目

哈希失败为**环境 / checkout字节变换**，不是导出更新后漏更新冻结哈希。当前工作区完整研究组和通知测试通过。临时干净克隆可复现EOL哈希失败；仅向该临时副本提供与冻结证据对应的原始字节，研究组32/32通过，未改变任何共享文件、哈希记录或阈值。

`configs/agent_tools.json`原始LF SHA256为`599b9c7a0186be978d01d9db64d9f51fb7926dd39ea3d316fd3949f58f871b70`；同内容转CRLF即`e9b4dcbb80ab19956c7fd1ff4b3dd10d6119f38e573a8354326cd8d3675f16f3`，与用户举例精确吻合。注意不能统一全库LF或CRLF：v2/v3 selection、storage_planner、temperature_planner等冻结SHA取CRLF，而若干plan/config/code取LF。raw Git blob副本仍有7条EOL失败，单一autocrlf设置不能恢复历史混合字节。按用户要求本轮不修环境，不提交换行差异，不更新冻结SHA。

| 文件 / 用例 | 结论 | 依据 |
|---|---|---|
| test_blend24::test_frozen_selection_once_final_and_metric_hash_reproduction | 环境：混合EOL | v3 plan LF `34bc0566…` ↔ CRLF `66aa105a…`；v3 selection CRLF `0d3deb6c…` ↔ LF `35778111…`。原字节全部指标断言通过。 |
| test_direct24::test_frozen_backtest_hashes_temporal_splits_and_all_metrics | 环境：EOL | v1 plan LF `95d4642c…` ↔ CRLF `08ee221e…`。 |
| test_direct24::test_forecast_contract_sources_midnight_rollover_and_conservation | 环境：输入未分发 / 未完整复制 | 初次临时克隆缺ignored data/deployment_daily/2017-01_multi.csv；补只读输入链接后通过，不需要改模型或测试。 |
| test_direct24::test_future_export_receipt_hashes_and_no_network | 环境：混合EOL | index CRLF `a158661b…` ↔ LF `036f62a1…`；blend_multi.py LF `475416a7…` ↔ CRLF `02ee89cd…`。 |
| test_shortfix24::test_frozen_selection_hashes_once_final_metrics_and_prior_splits | 环境：混合EOL | v2 plan LF `da3f24f4…` ↔ CRLF `29996769…`；selection CRLF `51d91179…` ↔ LF `c966ee6f…`。 |
| test_xgb_assessment::test_xgb_final_receipt | 环境：EOL | plan LF `af3e4b22…` ↔ CRLF `c29f5a8e…`。正确字节后通过，没有加载可选xgboost。 |
| test_holiday_calibration_research::test_research_frozen_plan_and_pooled_metrics | 环境：EOL | plan LF `3304a5fb…` ↔ CRLF `c3b69cd8…`。 |
| test_holiday_expansion::test_holiday_expansion_ablation_and_preservation | 未复现；当前环境通过 | 工作区及两种克隆均通过；若原日志是缺CSV/artifact则是ignored输入环境问题，但无原异常不能断言具体原因。 |
| test_holiday_replay_selection 两条 | 未复现；通过 | 实际假日/混合调度与numeric grounding均通过，未改断言。 |
| test_holiday_route::test_byron_actual_predict_uses_calendar_bundle | 未复现原失败；通过 | 默认及正确输入克隆均通过。一次诊断中更改临时clone迁移字节后复用旧测试DB造成applied migration changed；用新临时DB即通过，这是诊断副本环境问题，未作为原32挂原因。 |
| test_hvac_auxiliary2016::test_fixed_engineering_formula_and_development_freeze | 环境：EOL | plan LF `349d2bf8…` ↔ CRLF `5e84328f…`；src/data/hvac.py同样受checkout变换。 |
| test_multibuilding_retention::test_retained_improvements_and_receipts[multibuilding_ood] | 环境：EOL | plan LF `59854b95…` ↔ CRLF `67bf84ee…`。 |
| 同用例[multibuilding_pointonly] | 环境：EOL | 同上，正确字节和原输入后通过。 |
| test_round78_fixed_baseline::test_saved_comparison_costs_independently_recomputed_same_accepted_scope[normal] | 环境：混合EOL | 当前config产生599b/e9b差异；raw blob又造成storage_planner LF `4ca3996b…` ↔ 冻结CRLF `27628043…`。 |
| 同用例[peak] | 环境：混合EOL | 同上。 |
| 同用例[abstain] | 环境：混合EOL | 同上。成本和峰值原abs_tol 1e-6未变，全部通过。 |
| test_replay::test_replay_artifact_provenance | 未复现；通过 | 工作区、普通克隆、literal blob克隆、提供原始字节克隆均通过。models已提供；模型版本/历史时序证据匹配。若原日志缺模型属于输入环境，但需原异常确认。 |
| test_byron_daily_deployment::test_live_routed_api_uses_daily_gate | 未复现；通过 | 工作区和各克隆均通过，门控risk_threshold/abstain精确相等。原具体异常未提供。 |
| test_frontend_notice_sync::test_frontend_embedded_section_is_byte_identical_and_check_read_only | 环境：许可证EOL | 根通知保持原混合字节，但twin/public/THIRD-PARTY-LICENSES.txt受checkout转换；原始两个文件在共享工作区严格字节相等，克隆则\n/\r差异。未改twin或同步脚本。 |
| test_sentence_gated_stream::test_common_tool_never_waits_for_llm_selection[未来24小时峰值什么时候] | 按用户既定决定不处理 | 未添加skip，扩大范围运行用deselect明确排除此nodeid。 |

附：当前Python导入查找catboost/xgboost均为None，PYTHONPATH不存在；临时克隆没有.experiment-deps仍32/32通过。故这些已验证用例不支持“必需.experiment-deps”解释。原32条中未复现的其他异常仍需原nodeid/traceback，不能宣称逐条全解。


## 验证与限制

- 初始目标两组：10失败 / 9通过（撤销2、公开问答8），3.12秒。
- 数据库统一查询时钟、不编辑文件：3/3通过，2.13秒。
- 修复后公开问答/楼宇边界/operator_updates：67/67通过，14.11秒。
- 问答、公开来源、数值保护、冻结schedule等12个测试文件：222/222通过，50.90秒；无skip。
- 真实独立HTTP端口59400、临时数据库：86/86问答通过；进程已关闭，常驻未动，不写回归产物。
- 当前工作区研究与零散组：47通过，仅operator_updates旧诊断码1失败（修后已验证）。另replay_artifact_provenance单例通过。
- 复现临时克隆EOL：普通checkout 14失败/20通过，其中首次漏ignored deployment_daily输入；literal Git blob输入齐全则7失败/27通过；原始证据字节输入齐全研究组32/32通过（不含2个通知同步测试），25.31秒。
- 扩大到tests（明确排除Ops及指定峰值用例）的批次在240秒上限终止，约58%后仍运行；未获得终态，不能称全量通过。不重复无界长测试。
- main/detail/Ops对HEAD的字节检查通过；exports/index/buildings等已有他人工作区变更不纳入提交。
- 本轮应提交且仅提交：src/agent/general_chat.py、tests/test_open_conversation.py、tests/test_chat_operator_updates.py及本报告。app.py未改。
- 后端修复后：**需要重启**。
