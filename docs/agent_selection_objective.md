# Agent量化选择目标与真实重跑

## 查明的问题

原run_agent把第一个合规候选作为规则默认，LLM没有明确优化准则；通过约束只说明可执行，不意味着合算或削峰更好。看板自身ruleCandidates还把历史指令固定标为rule_full，并自行生成比较候选，没有取后端当时完整候选选择。

具体定位normal2017-10-23 14h：point1259.9kW、upper1282.2kW、PV114.3kW、储能0kW，历史设定24.5°C。前端单小时公式得到全额1352.0418元、保守1306.6854元；按显示1352.0与1306.7差45.3，按全精度差45.3564四舍五入45.4元。两者储能都是0，24.5比25.5耗电更多，不能解释为多花钱压峰。原历史记录没有可证实的预冷收益，不能事后编理由。

6b895d8曾只附历史审计，旧指令未换。现已按用户授权对72小时重新run_agent并真实调用provider，刷新agent/储能/SOC/grid，取消审计模式字段。agent.selected、selection_reason.selected_candidate_id及preferred_candidate_id完全一致、objective_optimal=True；提供宿主候选plan/objective_metrics/simulation及llm_mode/llm安全元数据给前端直接显示。

本次normal11小时LLM/13规则，peak10/14，abstain6/18；规则原因见experiments/agent_replay_export.json。normal14h已换25.5°C保持设定，rule_hold，两步成本2632.3元/上界峰值1126.3kW，相比两步rule_full2753.3元/1212.8kW，两指标均更好。不得和旧1352.0元单小时直接相减。

按原演示上下文current+next历史一步缓存重跑，仍属历史lookahead演示，不宣称Agent已用24步因果预测控制。只当前指令下发到日志；不是实物BMS连接。导出checkpoint专用版本绑定代码指纹，禁止复用旧选择。LLM当次失败按已声明目标回规则，不改模型或2017阈值。

## 新请求的统一目标

政策upper_grid_peak_then_cost_v1：通过温度/功率/SOC/拒绝时段安全检查之后，**优先最小化区间上界场景电网峰值，再比较电费，最后candidate_id稳定打破平局**。三个宿主生成候选rule_full/rule_conservative/rule_hold。保持设定候选为25.5°C、零储能，无预冷。不得因列表顺序选择。

区间上界电网峰值=max_hour(max(0,upper×configured_temperature_factor−PV−battery))，point峰值与energy_cost来自同一线性工具，预冷因子按该工具配置计入。不是把upper误称成置信概率；没有经过校准的反事实峰值保证或实测节费。温度因子目前仍为配置的全楼线性代理，热表估计为独立字段，未用于拟合节费。

没有当地需量费证据，不伪造“峰值惩罚元/kW”：peak_penalty_cny_per_kw=null，采用字典序峰值优先而不是凭空加权综合分。电费差额和上界峰值差额可直接量化。电价是现有配置演示口径，不声称真实账单。

## selection_reason契约

/schedule、/explain均返回：

- policy.id/priority/scope/peak_penalty_cny_per_kw（说明优先级、拒绝小时范围、未提供货币峰惩罚）；
- selected_candidate_id/preferred_candidate_id/objective_optimal；
- metrics按候选ID保存energy_cost_cny、point_grid_peak_kw、upper_grid_peak_kw、baseline_upper_grid_peak_kw、upper_peak_reduction_kw、comfort_degree_hours、accepted_hours/excluded_refused_hours、constraint_violations；
- compared_with_candidate_id为最低电费合规候选，additional_cost_cny和upper_peak_reduction_vs_cheapest_kw；
- summary中文短句，可直接显示。确实更贵且上界峰值更低时写“为压低区间上界峰值多花X元”，否则不能伪造收益；同峰时不会选更贵方案。缺上下文时电费null，不报差额。

完整数值用于排序，显示工具数值和差额保留1位；由宿主派生的summary同样check_grounding。LLM得到全部指标及preferred候选，可组织理由但不能违反声明目标；违背目标先反馈一次，再规则回退objective_choice_failed；幻觉数字仍重写一次后规则降级。追加宿主数值摘要，避免“通过约束”代替理由。拒绝小时转人工，全部拒绝不报收益。没有额外LLM调用用于历史审计/热表导出。

前端会话须改掉自身replay selected=rule_full，直接读agent.selected/candidates/selection_reason.summary，明确1h/2h口径，不能把两步成本当一小时。旧历史审计报告仅保留为之前状态记录，不再是当前决策。当前后端会话不修改twin/。
