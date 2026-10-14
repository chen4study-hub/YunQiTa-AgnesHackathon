# v2 第一步：上线话题拦截

## 改动范围
- /chat 与 /chat/stream 接入同一并行守卫，session_id透传；命中给terminated/category/answer，随后同session直接拒绝，不读取楼宇数据。
- 原v1事件及问答模型、数据工具和模板保留；未启用agent循环或history。
- 钩子修复JSON返回值丢失、分类8秒队列竞态、数据加载异常绕过分类、缓存正文释放与generator关闭；已终止的SSE会话绕过繁忙池准入直接拒绝。
- 专用分类provider只传分类指令/schema以及楼宇看板部署上下文，不用通用回答系统消息。没有修改topic_guard.py或其测试，它们属于其他会话。

## 验证
- 最终六个相关文件46/46通过，4.05秒：test_chat_topic_hook、test_chat_topic_api、test_topic_provider、test_chat_stream、test_chat_time_weather、test_open_conversation。
- 测试和最终真实回归使用已提交守卫blob eab886bf386d3f04ed0a80dbd5a0693c68e56228；共享工作区其他会话的守卫正在改动，未将其改动纳入本次提交或作为成功依据。
- 最终限定真实HTTP/SSE回归9/9，详见topic_guard_v2_real_20261013.json：政治、社会新闻各首次命中以及跨接口再问拒绝；天气新闻/诺奖不误拦；时间/天气/当前能源仍有效回答。
- 同session再问耗时0/32毫秒；时间/天气首次分类可能等满8秒，此为正文等待分类的已知延迟；能源整体9.94秒，未调整旧回答期限。
- 所有测试串行。真实测试单Python进程线程内起一个独立端口服务，finally关闭，临时DB清理；常驻后端未操作。未跑全量pytest或完整86题（本轮按用户限定范围）。
- 一条Starlette TestClient弃用warning，无失败。

## 调试过程保留
- initial：4/9，内外8秒队列发布竞态导致时事没终止和部分正文空。已修复。
- legacy_provider：8/9，能源省略主语被判社会新闻；当时共享守卫有未提交改动。
- shared_guard：9/9但依赖共享脏守卫，不作为本次成功依据。
- no_building_context：使用已提交守卫后8/9，确认能源行业歧义。添加可信部署上下文后最终9/9。
- 一次PowerShell脚本受执行策略拒绝，未启动后端；删除该脚本，没有更改执行策略。

本轮不修改数据库、ops、twin、导出、规划器或运行数据。不继续v2第二步。
上线后需要重启。会话终止仅当前进程有效；多进程或重启不共享。
