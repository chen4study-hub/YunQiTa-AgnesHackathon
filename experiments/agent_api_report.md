# Agent API migration and descriptive h3→h4 seam audit

## Interfaces

POST/schedule now invokes run_agent with constraint-valid deterministic candidates, bounded provider selection and log-only BA/EMS receipt. Existing Window building_id/start/end accepted; optional scenario selects exported current hour with explicit historical context. /explain uses the same pipeline with dispatch_enabled=False: explanations must not trigger device/log commands. Both return llm_mode from actual candidate processing (demo/mock/real or rule when bypassed); transport remains log_only.

Without complete replay context for a live one-hour forecast: explicit conservative context source, zero battery, no weather measurement invented, no cost/savings estimates. It can still return a valid safe pipeline result rather than fail merely because .env or economics context is absent. Existing forecast history/model requirements still apply: no observations/model is503, not invented forecast.

POST/chat is a closed deterministic tool router, not an unbounded LLM conversational agent. Payload scenario/origin/question. Gets24step evidence through get_forecast adapter over storedforecast_24h; peak query aggregates actual supplied points, including target date/hour and kW. Answers pass check_grounding with derived aggregate values as tool evidence. No factual answer beyond supported intents: exactly不知道. llm_mode on/chat is configured provider availability, NOT evidence of model invocation; llm_called=False and answer_source=deterministic_tools make this explicit. Unknown questions cannot cause arbitrary tools or prompts to execute.

What-if supports explicit24–27C comparison request, using simulate_schedule twice, baseline24C and requested setpoint, same forecast/electricity price. Origin weather persistence, zeroPV/battery scenario, configured demonstration tariff; no target weather/meter borrowed. It is an unvalidated linear scenario difference, not real saving. If any forecast refuses, both simulations return nullcost and answer不知道+human-review reason; no refusal overridden to manufacture full-horizon saving.

Demo and missing process config tested for all3interfaces; tests forbid HTTP. Missing .env is normal provider behavior (loads optional .env once at import), simulated tests clear relevant loaded environment values rather than deleting user .env. /explain and/chat are read-only. Result does not include key, endpoint or key-file content. No new real export; old source counts remain final export statistics, not API request count.

## h3→h4 seam (unchanged)

Largest differences over24origin paths per scenario, using exported rounded points. This is descriptive inspection, no threshold/smoothing adjustment or model retuning.

| Scenario | max abs delta34 kW | median abs delta34 | median abs delta23 | median abs delta45 | largestorigin | actualchange atsame targets |
|---|---:|---:|---:|---:|---|---:|
| normal |130.7|28.45|20.25|28.0|2017-10-23 04h|+141.8|
| peak |153.0|63.1|25.85|29.4|2017-07-20 15h|−119.9|
| abstain |207.4|18.4|16.35|22.2|2017-07-04 11h|+9.4|

**Obvious seam example**: abstain11h path,h3at14h993.9→h4at15h1201.3 (+207.4,+20.87%), neighboringchanges−2.2/−23.7, actual14→15honly+9.4. Likely band/anchor mismatch, but no causal ablation performed, not asserted unique cause. Peak median seam63.1larger than neighboring25.85/29.4also warrants future development-only continuity research. Normal maximum is consistent with morning actual ramp, so not every h3→h4change is artificial. Measurements from frozenexports/rawmeter in horizon_seam_diagnosis.json; predictions untouched.
