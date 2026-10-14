# tool_end即时发布修复

**需要重启。默认开关和前端不改。**

已找到直接2秒延迟原因：chat_topic_hook.guarded_events在分类未完成时将tool_end/tool_result放入pending，和answer_delta/done一起等分类/正文完成才发。tool_start即时发、ms记录工具执行本身，因而看起来经过约2秒但只有35.6/24.5 ms。现在只暂存正文和done，工具完成事件即时透传；公开工具仍在tool_start前等待话题批准，敏感话题终止/正文闸门不变。

另修预取头部阻塞：过去按提交顺序future.result，快工具已完成也要等排在前面的慢工具。现在worker实际开始/结束计执行ms，结束即入完成队列，generator立即发布对应id的tool_end；工具trace/模型证据仍按计划顺序归档，事件允许按真实完成顺序。tool_start仍先发后立即提交工作，没有先执行工具后事后补发。

针对单测3个：模拟延迟分类且模型尚未继续，tariff_periods/storage_history结束后收到tool_end距离实际ended<80 ms；预取慢200ms/快25ms时快工具先发tool_end，收到距ended<80ms，ms与真实执行差<10ms、start收到至worker开始<80ms、records仍稳定、无预取线程遗留。29项相关测试通过9.84秒（只测试本时序版本，未夹带未完成评分/多轮runner改动）。不是生产网络延迟承诺；代理/浏览器另可缓冲，未据此声称上线一定<80ms。

单独提交agent_runner.py仅prefetch段、chat_topic_hook.py一行、该测试/说明，不提交其它会话web/general_chat/router变化，也不提交评分/多轮进行中改动。不改app.py、常驻后端、SSE旧事件名和字段，无新时间字段。工具完成不再等待模型或分类，不改变前端毫秒显示职责。
