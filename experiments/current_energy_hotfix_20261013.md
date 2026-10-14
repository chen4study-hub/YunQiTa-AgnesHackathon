# 线上能源路由缺陷修复（2026-10-13）

基线：72ea036；只修现有问答，不接原生agent循环或变更守卫等待参数。

## 根因
- `intent('当前能源怎么样')=unknown`，`building_reading_question=False`，`fast_choices=[]`：能源的省略主语说法漏过关键词及本楼读数边界，随后进入LLM route并可能选general_chat/web_search。守卫不负责选择数据工具，此缺陷不是classify_topic路由。
- “现在用电情况如何”已有energy_totals快捷路由，添加测试和回归保护。
- “光伏现在发多少电”虽然intent为current_energy，但更早的fast_choices中“多少电”触发pv_generation，按累计发电量处理了瞬时问题。
- general_chat无联网来源时，给模型任何有效文本无条件加“常识整理”前缀，连“没查到相关资料”也被加前缀。

## 修复
- 增加窄的整句当前能源/光伏功率语法，在快捷累计数据选择之前走current_energy，并补本楼读数判定。行业新闻、能源定义、光伏科普不命中新增快捷路由。
- 空的资料查找回答统一“没查到相关资料。”；有实际常识内容时保留原常识整理提示。JSON与SSE及无末尾标点均覆盖。
- tests/building_chat_cases.json增加3题，回归集从86到89；本轮用户要求只跑相关测试，未跑完整回归。

## 验证
- 五个相关测试文件64/64通过，16.69秒，1条既有Starlette弃用warning。
- 真实provider、进程内HTTP/ASGI三题3/3；结果current_energy_hotfix_real_20261013.json。工具分别current_energy、energy_totals、current_energy，无web_search、无终止。
- 当前能源和光伏题上游回答首token超过旧8秒，使用本楼工具模板；这3/3仅证明数据路由和回答正确，不代表LLM延迟已经解决。
- 单Python进程串行，没有启动独立或修改常驻后端，无API接线、导出、ops、db、规划器或twin更改。

需要重启。下一步继续隔离agent超时对比实验；守卫等待上限接口待用户提供。
