# Compact chat validation

Checkpoint: 2dd171c. All batches are preserved; no individual question rerun chosen by success. Initial batch 8 LLM / 2 host-direct / 0 failed fallback. Latest frozen ten-question batch 4 LLM / 2 host-direct / 4 timeout fallbacks. These are two independent runs, not a claim of a stable ratio improvement.

|Question|Source|Total ms|Select ms|Answer ms|Failure|
|---|---|---:|---|---|---|
|现在几点|host_direct|50.5||||
|天气怎么样|llm|6835.8|2906.0|3891.0||
|今天日期是多少|host_direct|38.0||||
|现在储能电量多少|llm|15478.3|1343.0|14094.0||
|为什么这样调度|template|19603.5|1547.0|18016.0|chat_deadline / answer|
|执行回执是什么|template|10051.5|10015.0||chat_deadline / select|
|未来24小时峰值什么时候|template|10042.4|10015.0||chat_deadline / select|
|明天最高负荷|template|19485.6|1437.0|18000.0|chat_deadline / answer|
|空调改26度电费多少|llm|12183.3|7578.0|4547.0||
|为什么转人工|llm|12333.1|1828.0|8391.0,2062.0||

All latest first events <1s (1.3-2.6ms); 10/10 known and grounded. Four failed fallbacks were deadline failures: scheduling answer, receipt selection, 24-hour peak selection, tomorrow peak answer. Required-value and false-receipt validation did not cause these four fallbacks. Time/date direct answers are not service failures and are not LLM prose.

The latest answer stage did not consistently become faster: scheduling reached 18s; handoff took 8.391+2.062s with one rewrite. Initial scheduling 7.281s, handoff 1.813+1.890s. No latency guarantee or restored >60% LLM ratio is claimed for the latest batch. Transport timeout retries remain disabled for chat.

## Prompt size (normal hour14, same result evidence)

|Tool|Previous evidence JSON chars|Compact evidence JSON chars|Previous reference chars|Short reference chars|
|---|---:|---:|---:|---:|
|selection_reason|15813|1298|289|74|
|handoff_reason|13010|309|34|34|
|hvac_compare|34996|1399|192|192|
|execution_receipt|12966|284|60|60|

Prompt character counts measure serialized evidence only, not provider tokenizer counts or service compute. No dispatch/economics changed. Full audit traces retained.

## Added fixed questions

- 现在几点、天气怎么样？: tools=['get_time', 'get_weather']; source=llm; answer=现在 13:44。 14:00–17:00 室外气温 13.3 °C，湿度 57.2%。
- 今天几号: tools=['get_time']; source=template; answer=今天是 10 月 12 日。
- 现在几点天气怎么样？: tools=['get_time', 'get_weather']; source=template; answer=现在 13:44。 14:00–17:00：室外 13.3 °C，湿度 57.2%。

About disclosure text for dashboard owner is in docs/compact_chat_checkpoint.md. Dashboard synchronized copies and About are not submitted by this round. Backend requires restart; resident was not restarted.
