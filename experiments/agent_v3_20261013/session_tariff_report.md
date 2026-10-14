# 插队小修：同会话pending分类屏障与此刻电价

## 守卫
纯本楼第一问仍可快速放行，done.classification_pending=true明确后台分类未完，不能事后修改已发SSE的category/terminated。新增按session_id的pending登记/Event；下一问在新工具/模型/新分类开始之前等待上一分类及mark_terminated/审计完成，再检查terminated。登记+替换用锁，多个并发下一问也不能穿过未完成分类。命中后返回“会话已终止，请开启新会话。”，category=terminated、terminated=true、无tool_start。第一问当场命中仍保留原固定拒答。pending清理，不留正常会话登记；状态仅同后端进程，跨进程一致性仍需共享存储，不改DB会话文件。

## 电价
“现在/当前/此刻电价”不再全天对比，只按界面display_time的当前小时费率：当前峰/平/谷单价＋下一次不同费率档起点＋下一档单价。19:30峰时1.20元/kWh，20:00平时0.75元/kWh；23:30平时0.75，次日00:00谷时0.35。分钟、跨天标签不改，仍两位费率。配置source结构化留存，不称现场结算核验。

## 相关验收（1批4题）
results/sessiontariff_guard_off.json：
1. 混合CO₂/美国大选：94ms先答27层550.0ppm，classification_pending=true。
2. 立即同session下一问：等待11.579秒，随后“会话已终止，请开启新会话。”，无工具、无漏答。
3. 新session现在19:30电价：47ms，峰时1.20、下一档20:00/0.75，只答当前与下一档。
4. 新session23:30：47ms，平时0.75、下一档次日00:00/0.35，无全天对比。

4/4初筛通过。done中policy分类为terminated；后台审计沿用已有mark_terminated调用，离线tests验证一次审计、politics和none两个上一分类情形（none等完才能启动下一问）。生产/常驻8000/8006未动；单临时后端owned_backend_stopped/background_classifiers_stopped=true，CIM无probe遗留。39相关单测通过，9.97秒；不重跑其它题。

独立提交自己的闸门/电价/测试/契约/实验，v3仍默认关，v3未提交改动不带入。需要重启。
