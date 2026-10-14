# 问答与值班措辞更新验证（4问）

独立启动当前后端真实HTTP实例，未接管8000常驻；试验结束关闭自有进程。表格为最终代码的固定4问，各问一次；此前开发轮次用于定位内部政策句校验失败及“改到/电费降/少付”等补句识别缺口，不将多轮结果合并为成功率。phase耗时含传输/退避，transport_attempts逐条为单次物理接口耗时；不含key/headers/URL/失败正文。

|问题|首事件ms|首回答字ms|总时长ms|措辞来源|回退阶段|select ms|answer ms|单次物理调用ms|
|---|---:|---:|---:|---|---|---|---|---|
|为什么这样调度|2.6|8069.5|8076.7|template|answer_stream||8016.0|[]|
|明天最高负荷|1.6|7138.2|7147.1|llm|None||7094.0|[7094.0]|
|空调改26度电费多少|2.0|3211.2|3982.5|llm|None||3922.0|[3906.0]|
|当前光伏、电网和储能功率是多少|2.3|2869.9|2876.0|llm|None||2828.0|[2813.0]|

LLM完成3/4；宿主直接回答0条（非服务失败回退）；首事件均<1秒：True。
本次调度问答首 token 超过8秒，原因 chat_first_token_timeout，约8.07秒收到模板；不是校验失败。另3问有LLM回答，改温度的263.4元仅出现一次，模板只补缺失的改前电费；次日范围说明未被拆句。网络首token快不等于首个已核验句子快。

## 事件契约

已有 step/tool_start/tool_end/answer_delta/done/error 名称及字段保留；新增事件：

```json
{"type":"progress","id":"chat-answer-wait","text":"正在组织回答，已等待 1 秒","elapsed_seconds":1}
```

固定 id 可供看板覆盖更新；从等待1秒开始每秒更新，在首个已核验回答句发出或模板返回后停止。8秒首token预算只计算该次上游调用开始后的首个非空 text_delta；短于8秒的剩余全局预算仍优先限制。phase_timings新增 first_token_ms、first_token_timeout_seconds、validation_failures；没有首token时 first_token_ms=null。超时后取消消费迟到片段，不重发请求，不接管常驻后端。

## 调度校验原因

旧 chat_sentence_stream10_final_results.json 记录LLM调用成功但0句通过，未保存原文或细分原因，不能断言旧那一次的唯一原因。开发实测复现 validation_failures.internal_policy_wording=1：原文含容差/微差/首步/重规划内部术语，整句丢弃。从 compact_evidence 的问答提示视图移除整份 policy，保留完整 tool_trace 及原校验规则；同步加强提示词，不放宽来源、单位、费用交换校验。后续失败计数只含本地枚举，不保存被丢弃原文。

## 离线导出

沿用 scripts/refresh_compact_prose.py：先按LLM来源删除含容差/微差的整句，再应用值班措辞。规则保守方案→保守调度方案；选择已通过约束与目标检查的候选→选用满足设备限制、兼顾峰值和电费的方案；按区间上界 X kW准备→按负荷上限 X kW安排调度。非文字字段逐项一致，schema通过且重处理幂等，0次LLM调用、0次下发。来源计数前后相同：normal llm16/template8；peak llm15/template7/rule2；abstain llm11/template1/rule12。见 chat_operator_cleanup.json。

## 当前能源工具

current_energy直接读取当前行 pv.power_kw、grid_kw、storage.power_kw，不用预测代替当前、不计算新数字。光伏/电网/储能功率以kW输出，缺项说明记录缺失；储能正值放电、负值充电。ToolChoice、可用工具及provider选择枚举已同步。

## 工作区隔离

许可同步 a52d392 已单独提交并立即push，只包含 THIRD_PARTY_NOTICES。不修改 twin/，不提交 docs/agent_flow.md、exports/buildings.json、exports/replay/index.json、tests/test_hourly_agent_replay.py、tests/test_replay.py 的既有换行符差异。密钥未写入文件。

测试：全套按文件名分为两组运行，278 + 159 = 437 项全部通过；仅 FastAPI/Starlette TestClient 弃用警告。单次全套运行超过120秒工具时限，因此改为两个完整互不重叠分组，没有跳过测试。8秒边界与每秒progress采用受控慢provider测试；真实独立HTTP最终4问全部通过措辞/事件断言，3问LLM、1问按8秒门限转模板。导出schema、非文字字段、来源计数与幂等性均验证。
后端需要重启加载本轮代码。本轮没有重启生产常驻服务。
