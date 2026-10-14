# 插队修复：纯本楼数据快速放行、电价单位与时段措辞

v3保持默认关闭。新闸门只依据完成管线的实际来源：known/grounded、非空、trace均本楼允许只读工具、explanation_source=template、answer_source=deterministic_tools，且全事件没有模型句/对外工具。含模型句（包括混合）、未知来源、无trace、web_search/city_weather照旧等待分类。不是靠关键词预判安全。

本楼数据回答可以先完成，done增加classification_pending=true、classification_timing.local_data_bypass=true。分类仍在独立线程继续；涉政/时事命中mark_terminated先设内存状态再写既有DB审计，下一问拒绝。不会在已结束SSE后再推事件；后台完成前的短暂窗口尚未terminated（按用户异步政策），不同后端进程状态仍不共享。已有命中如果先于本楼回答完成，仍当场拒绝而非绕开。

电价展示统一两位小数元/kWh（0.35、0.75、1.20），小时电费仍一位小数。chat reading_text与通用render_public_fields保留两位费率，numeric data不改；不改twin、ops、configs或exports。看板若自行格式化结构化数字，需看板会话同步此规则，本会话不改其文件。

同价直接合并范围：“12:00–18:00 都是峰时电价 1.20 元/kWh”。因果按已验证等式解释峰时单价加小时用电量；13–14用电1265.7kWh，所以1518.8元最高。全天低价00–07，0.35元/kWh；最低小时费用03–04，271.9元。峰值低把握改“这个时段预测把握不大，暂不自动执行”，保留abstain/needs_human机器标记不变。

## 真题（只这一批5题）
收据results/localgate_full_off.json，临时独立端口，逐题HTTP耗时：
- 27层CO₂：93ms，正文62ms完成，classification_pending/本楼旁路；实际550.0ppm（初筛预设768ppm是全楼环境而非27层，初筛false但语义值正确，不改收据）。
- 今日电费：62ms，10249.4元正确，不等分类。
- 下午最贵：63ms，峰时1.20元/kWh、13–14最高及费用/原因正确。
- 最便宜：63ms，00–07低价0.35元/kWh正确。
- 明天峰值：2282ms，1279.7kW、明天13:00、新措辞；模型候选被句子门拒后纯工具补齐，分类当时已快速返回。

5题4个固定断言通过，CO₂为错误fixture字面，不将其算真实错答。原同题新旧批次不随机，速度只说明本楼数据已脱离分类等待，不比较上游平均性能。

probe finally等后台classifier线程退出再删tempDB、停止owned server；receipt owned_backend_stopped和background_classifiers_stopped均true，CIM无本会话probe残留；8000/8006未动。后台分类仍是限额线程，实际上游延迟不计入已完成HTTP答复时间，不能隐藏为“无分类耗时”。

最终单测37通过（10.93秒）：后台politics/current_affairs在本楼答复完成后标终止/审计且下一问无工具；模型/混合/联网/城市天气不能旁路；价格重复展示保精度及低把握峰值措辞。不重跑47题或旧24题。需要重启。
