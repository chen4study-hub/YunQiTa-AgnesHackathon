# 0cfe063完整验收产品缺陷修复

**需要重启。** 本批只修src/agent/agent_relevance.py；未修改tests/已有文件、takeover.py、web_search.py、general_chat.py、app.py、twin或exports。

## recent_news缺answer

根因提交dc6ed8f（2026-10-13）：移除标题关键词筛选时，同时移除了news_result摘要构造，改为只补recent_news/lookback_days；有sources分支不再保证answer存在。搜索服务3d4e37a改为通用排名结果，answer可为None；fixture可完全省略该字段。旧general_chat direct_recent_news分支直接读取evidence['answer']，导致KeyError，不是0cfe063限流改动引入。

最小修复：filter_result对新闻始终提供answer。有来源时保留已有非空answer；缺失/None/空串时复用source_reference，根据原title/snippet与真实URL生成摘要。无来源仍固定“没查到相关报道。”。不重新裁剪排名来源、不增加网络请求、不要求每条后备来源必须有published_at，不改事件契约。

验证（未改测试）：
- 修前：python -m pytest tests/test_building_chat.py -k u65b0 -q --tb=short，6失败/1通过/92排除，6条均为KeyError: answer。
- 修后同命令：7通过/92排除，1.44秒。6条原失败全部通过。
- 相关来源/预取/公开边界及迁移收据：test_agent_ranked_search.py、test_agent_v3_prefetch.py、test_agent_public_repair.py，加test_transfer_current.py的test_exported_model_card_matches_receipt与test_result_counts_integrity_and_card_semantics，共33通过，7.27秒。
- 没跑全量pytest或前端全量验收，没启动或改动常驻后端。最初-k中文未匹配因pytest ID被转义，99排除，随后改用转义片段u65b0准确筛选。

## model card差异：看板副本未同步

正确来源为exports/model_card.json（a809986，当前Byron单步模型迁移评测），并非导出脚本算错：
- exports.cross_building_coverage = 0.9274450461930551。
- experiments/transfer_current_20261013/results.json的early_only.transfer同值：retained_covered_n=11,645 / retained_n=12,556。
- 收据SHA256：2c1efff2d2e7443f1a3469b4cfac608720fb684dfb65ab08c50970388a2bbe09；现有模型卡记录一致。两条完整收据测试通过，包含计划、预测哈希/分母/版本/主协议核验。
- twin/public/replay/model_card.json仍为2356c1a同步的旧副本，cross_building_coverage=null。顶层实际差异仅cross_building_coverage、cross_building_context、cross_building_evaluation三项。

**交看板会话同步**：将当前已提交exports/model_card.json同步到twin/public/replay/model_card.json，再跑twin/tests/replay-1.4.test.tsx中的副本一致性测试。不要回退exports数值以迁就旧副本，也不要只拷数值而漏掉评测上下文及凭证。多步cross_building_coverage仍null，单步92.7%不是所有建筑/所有预测步的泛化保证。

本会话未触碰twin，故前端那条一致性红项要待看板同步后才能宣布通过。仅提交本人文件列表并立即push，不force。
