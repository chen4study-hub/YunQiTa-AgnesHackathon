# 公开文字与显示日期

## 请求

`POST /chat`、`POST /chat/stream`、`POST /schedule`（及共用请求的 `/explain`）增加可选 `display_date: string | null`。

- 格式严格为 `YYYY-MM-DD`，必须是真实日期且次日可表示；错误格式/不存在的日期返回422，进入provider或下发前拒绝。
- 未传或null：用户可见时刻仅 `今天 HH:MM` / `次日 HH:MM`，不输出绝对日期。
- 传入：普通回答/理由仍只保留今天/次日，不每处附日期；只有用户问日期，get_time答案末尾由宿主写一次display_date（显示日期），不写星期。
- 以起报源时间戳的当地日期区分今天/次日，再用display_date映射显示。绝不借服务器时钟或历史日历名猜日期，也不让LLM自行指定显示日期。
- 仅显示别名；原始origin/timestamp、forecast、控制、经济指标、ID不变。不因此宣称历史模型已对显示日期做实时预测。绝对日期数字只由已验证的请求参数作宿主装饰，在原始数值/时刻grounding之后插入，不能为LLM草稿中的未来源数字放行。
- get_time读取当前起报小时及可选显示日期；get_weather读取气象。未知事实仍返回不知道；传入display_date不会使未知事实变成已知。

请求示例（origin仍必须是接口支持的起报时间戳）：

```json
{"scenario":"normal","origin":"2017-10-23T12:00:00-05:00","question":"明天最高负荷","display_date":"2026-12-31"}
```

## 文本口径

统一 `display_text.wording_text` 清理UI字段，`public_text`在grounding前转换源日期/时刻并验证来源。移除星期与节日名；不对字段名、机器来源标识或契约说明做字符串替换。未知/歧义时刻不用猜测，回退宿主或不知道。

禁用公开词：情景、典型日、代表日、估计、高温日、节假日、国庆，以及此前禁用词。使用 `线性计算`、`预测值，非实测`、`当日` 等中性表述；保留非实测、接受/排除小时、非全天费用和人工核对等限制。删除日期名不会删除其旁边未来源的功率/费用数字。

显示字段：title、display_name、label、answer、explanation、summary、reason、actions、possible_reasons、suggested_checks、text、message。只渲染这些字段，机器时间戳/工具ID/配置和契约不重写。JSON答案与SSE拼接答案共用同一管线；API返回/stream done的explanation_source语义不变。

## 重导出

`python -m scripts.refresh_live_display` 是离线文本操作：使用已有保存结果，不调用provider、不执行新调度、不重跑2017评测。先校验全部，再写受影响导出；非公开文字字段（含source、explanation_source、控制、经济、时间戳）必须逐项相同。更新当前export回执SHA，新回执为 `experiments/live_display_refresh.json`；旧display/grouped/v1–v4证据保留。禁止用显示别名伪造新评测证据。

常驻后端需要重启才能加载代码。本轮不改twin。公开英文候选ID只在机器字段保留；文字为全额调度、保守调度、保持设定，SOC写电量。
