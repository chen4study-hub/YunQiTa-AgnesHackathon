# Replay 1.4：给前端的解释来源说明

`schema_version` 升为 `1.4`。除版本标记外，JSON Schema仅新增一个**可选**字段：`hours[].agent.explanation_source?: "llm" | "template"`，不加入required，不修改既有字段含义。

- `llm`：保留了通过grounding和格式检查的真实LLM措辞。最终文本仍可含宿主补的上界数字和候选摘要，不代表整段都是LLM原文。
- `template`：最终解释正文全是宿主模板。包括真实LLM选案但原文格式不合规、规则回退、当前拒绝转人工，以及demo/mock。
- `agent.source`仍是**选案来源**，不是措辞来源。`source=llm, explanation_source=template`合法，不得标成规则选案；`source=rule`对应`explanation_source=template`。
- 老记录可没有该字段；缺失时展示旧解释，不把未知来源推定为LLM。
- live `/schedule`、`/explain` 沿用其扁平结构，在响应顶层携带同名`explanation_source`，由同一个run_agent产生。Replay则位于agent内。没有改chat/SSE契约。

## 三天重新导出（真实调用、每个时点一次保存）

三列互斥分类：先分`source=rule`，其余真实LLM选案再按措辞来源分llm/template。

|日期/场景|LLM措辞且LLM选案|模板措辞且LLM选案|规则选案|选案source=llm合计|
|---|---:|---:|---:|---:|
|2017-10-23 normal|14|10|0|24|
|2017-07-20 peak|15|6|3|21|
|2017-07-04 abstain|12|0|12|12|

规则共15小时：14小时当前预测拒绝，1小时grounding回退（高负荷日第二小时）。按纯字段值计数，template还包括rule，分别为10/9/12小时，llm分别为14/15/12。每小时最终数字来源校验通过；储能功率/SOC、grid、选中候选/设定温度与前版一致（离线测试）。grounding/模型/阈值/控制未改变，没有重跑13天或测试集调参。sample只升版本，保留人工样例且不强填可选字段。

## 兼容性边界

字段层面是可选新增，前端忽略新字段无需改展示逻辑。第1项提交时`twin/src/data/validate.ts`只注册1.2/1.3，原严格版本前端会拒绝1.4。因此旧版本白名单仍需扩展。收尾只读复核发现并行前端提交`6f4e8a7`已经注册1.4并区分措辞来源；该前端适配不是本轮后端代理所作，未替其执行验收。这轮没有修改任何twin文件。

最终完整后端pytest176通过，1个既有Starlette/httpx warning；新增测试验证schema除版本外只有该可选字段、缺失可验证、非法枚举拒绝、真实LLM措辞/模板/grounding回退语义和72小时分类。凭据原字节扫描及暂存秘密检查后提交。常驻服务未接管，需重启加载run_agent代码。
