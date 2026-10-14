# 20秒守卫与fallback模式适配

守卫版本770d045，只读。分类调用显式timeout_seconds=20，外层队列等待同为20秒；工具/progress照常推送，正文等分类结果。20秒边界继续使用守卫无provider保守兜底避免队列竞态。专用分类transport取消自身8秒截断，向守卫保留TimeoutException以支持其预算内重试；没有新增适配器重试。

正常done与JSON新增mode，按实际回答来源标llm/fallback，而不是配置的LLM_MODE。发现任何first_token_timeout优先fallback，包括部分其他子任务已成功的情况。本楼模板回答不因provider为real而标llm；已验证模型措辞仍为llm。繁忙/异常done缺mode时API补fallback。

相关七文件65/65通过（5.24秒），1条既有Starlette弃用warning；覆盖内外预算、超过旧8秒仍等待分类、工具先推、命中正文丢弃、超时transport信号、真实engine首字超时的工具模板以及两个公共接口mode。仅mock测试，未追加真实请求；守卫会话的22题不是本会话验证成绩。

不改导出、规划器、数据库、ops、twin或守卫文件；未启动后端，常驻未动。需要重启。
