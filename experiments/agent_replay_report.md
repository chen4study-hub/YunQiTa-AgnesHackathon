# Three-day Agent replay: holiday replacement and free explanations

All72hours re-exported through run_agent using current+next historical cached one-step predictions, applying only current command. New v2 checkpoint does not reuse prior fixed explanations. Transport remains log_only/device_connected=false, no hardware.

| Scenario/date | validated llm | rule | rule reason counts |
|---|---:|---:|---|
| normal /2017-10-23 |14|10|grounding_failed10|
| peak /2017-07-20 |10|14|grounding_failed7, explanation_format_failed2, refused_horizon4, call_failed1|
| abstain /2017-07-04 |9|15|grounding_failed2, refused_horizon13|

Total33llm,39rule,0mock. call_failed observed as ReadTimeout with no HTTP status. refused_horizon is intentional LLM bypass for current/next refusal, not a network failure. The holiday has12actual refused hours with handoff work orders and12automatic hours;13refused_horizon sources include one accepted current hour with rejected lookahead. source=rule does not imply every such hour is handed off.

LLM now writes its own short Chinese explanation of selection/actions instead of repeating a fixed sentence. Numeric tool leaves presented to it are rounded to one decimal; numeric grounding uses that same view, requires upper preparation, and rejects extra precision or banned product terms. Original candidate controls and simulation/forecast data retain precision for constraint checks, SOC and dispatch. Agent action display uses one decimal; grid/SOC use actual selected power. Numeric matching alone is not a complete semantic truthfulness proof. Free explanations caused many grounding fallbacks this run; these are honestly rule, not relabeled llm. No subsequent attempt to loosen grounding to improve counts.

April9diagnosis and holiday-ranking rule are in april_refusal_diagnosis.md/json. High predicted scale rank dominates rejection, not proven meter corruption or a causal weekend effect. July4selected from federal observed dates with mixed refusal,10h refusal priority; model/calibration unchanged. Existing peak selection rule yields July20. Holiday rejection33.75% versus15.67%otherwise is descriptive full-year backtest evidence, not permission to tune on selected replay/test days. No special holiday calibration fitted.

All58tests passed: contracts, real-holiday/mixed-refusal check, one-decimal tool grounding, original control precision, source counts, SOC/grid conservation, current-only dispatch, and secret hygiene. Exports and receipt contain no credential material; credentials remain runtime-only ignored .env/key-file. Scheduled export completed and disabled. twin/ untouched. Receipt hashes in agent_replay_export.json refer to these three regenerated files. Prior logs may contain earlier exploratory attempts; receipt counts final72hours only.
