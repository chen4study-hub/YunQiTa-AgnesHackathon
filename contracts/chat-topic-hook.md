# v2 第一步：现有问答话题守卫

已接入 `POST /chat` 和 `POST /chat/stream`。保留v1问答、模板降级、原step/tool_start/tool_end/answer_delta/progress/done/error事件；不启用原生agent草稿。

## 请求与响应

原请求字段不变，新增 `session_id?: string|null`（1–128字符，不能全空白，默认null）。JSON响应与所有SSE done原样带回session_id，包括错误/繁忙出口。省略ID时不共享匿名会话状态；只能用显式稳定ID延续会话终止。该ID不是鉴权凭据。

命中：answer_delta为 `refusal_message()`，sentence_source为policy；done和JSON响应带 `terminated:true/category/answer`，首次answer为固定拒绝话术；已有terminated会话的后续answer为“会话已终止，请开启新会话。”，reason=out_of_scope、known=false、needs_human=false。不泄漏分类reason或被丢弃正文。

同一session_id后续请求：先is_terminated，直接拒绝，不分类、不读取楼宇数据、不调用回答模型。category=terminated（守卫接口不提供原类别读取）；首次命中为politics或current_affairs。

未命中：正文、工具数据与已有事件字段保持不变；done和JSON响应新增terminated=false/category=none/session_id。正常done不重复正文。异常done也带这三个字段。

状态由topic_guard管理，仅当前后端进程有效；重启或不同进程不共享。mark_terminated记录审计，写库失败也保留内存终止。

## 并行与时限

`src/agent/chat_topic_hook.py::guarded_events` 在入口检查会话状态，否则分类与v1问答并行。独立TopicClassificationProvider，仅接受守卫分类系统消息和结构化分类工具，不混入通用回答指令，不与回答共享连接/取消状态。附加可信“楼宇看板”部署语境，省略主语的能源/用电问题指本楼，不据此放行明确外部新闻。分类内外总预算20秒（classify_topic(..., timeout_seconds=20)，守卫内部仅超时重试一次，总期限不重置），progress及本楼只读工具开始事件照常推送；本楼结果事件等分类none后才推送，命中丢弃；web_search/city_weather开始事件必须先等分类none再交给客户端并推进generator执行，命中不执行请求；包含模型措辞或使用对外工具的answer_delta必须在分类none之后才能发。例外：整条管线完成后，实际tool_trace全为本楼只读工具、known/grounded且explanation_source=template、answer_source=deterministic_tools，且没有任何llm sentence_source或web_search/city_weather事件，可直接放行已核验本楼数据（不依据问题关键词）。done带classification_pending=true、classification_timing.local_data_bypass=true，category=none只是暂时未判定，并非后台完成。独立分类线程继续，命中照常mark_terminated及审计；下一问is_terminated拒绝。没有新事件名称，不在流完成后补推事件。同一进程按session_id登记pending分类；下一问进入时若上一分类尚未完成，先等上一分类和审计结束，再重新is_terminated，完成前不读新工具/启动新回答。pending登记与检查原子化，避免并发下一问绕过。命中后的下一问固定返回“会话已终止，请开启新会话。”；后台完成前第一问已发送的done保持classification_pending=true，不伪称分类已完成。命中丢弃缓存正文，关闭问答generator并调用mark_terminated。分类服务异常不泄漏缓存正文，返回error/no_data；正常分类超时由topic_guard自己的保守规则兜底；到20秒尚未收到队列结果时调用classify_topic(question, history, None, timeout_seconds=20)，避免内外20秒期限的发布竞态。

两端通过同一适配器，JSON消费generator返回值保留正常tool_trace和回答来源。加载工具数据失败时仍等待分类：敏感题先拒绝，非敏感题保留既有API错误出口。

本轮不加入history或function calling；它们留待v2下一步。topic_guard.py由其他会话维护，本轮只读。上线后需要重启。

## 回答模式

所有正常done和JSON响应带mode=llm或fallback，按实际回答组成而不是环境配置标记。本楼工具模板回答（含楼宇正文LLM首字12秒超时后的纯工具兜底）标fallback；已验证模型措辞标llm。首字超时标记优先，不能因尝试过LLM或部分其他任务成功而将整轮标llm。事件名称和原字段保持不变，新增mode。
