# v3 frozen transition bridge and real-mode tool chat

## Forecast protocol

Plan multi_horizon_v3_plan.json written before any candidate run.2016July-Dec physically clipped data compared v2and two overlapping-expert bridges. Short expert trained2-6with origin-load residual anchor; long expert3-6with seasonal daily anchor. Same latest-lag features and causal weather persistence. h3-6long weights: linear20/40/60/80%, slow10/25/50/75%; no test-optimized knots. Point/rawquantiles/predictedscale/constantprior blended, then Cq risk ranks/gate/CQR corrections recomputed per horizon. Not averaging already calibrated interval endpoints. h1original1step and h2/h7+v2points unchanged; h2+confidence re-fit past completed targets for v3.

Selection eligible if2016h3-6MAE<=v2*1.05, retainedcoverage>=87.5%research screen, and seam delta prediction-minus-actual meanerror<=v2*0.9. Both passed; slow selected by smaller seamerror. Freeze artifact written before selected2017evaluation. No post2017retuning.2017previously viewed for v2not blind. Corrected coverage remains empirical pooled hourly coverage, not independent trajectories or joint24hguarantee.

| 2016 | h3-6MAE | retainedcoverage% | rejection% | mean abs h3-4jump | mean delta error | h6-7delta error |
|---|---:|---:|---:|---:|---:|---:|
| v2 |25.749|89.55|17.90|44.206|28.257|18.812|
| linear |23.076|91.84|17.51|31.323|13.805|20.969|
| slow |22.967|91.84|17.24|31.032|13.712|21.196|

## Once-only2017results

h3-6pooled MAE27.394→23.936, coverage88.69%→90.91%, rejection19.17%→19.84%. h3MAE19.608→20.510 worsens; h4-6improve. h1=11.592,h2=17.729unchanged; h7-24points unchanged. Four horizons3-6individually reach empirical90.5%, remaining horizons do not. Do not claim all-path coverage or general achievement.

|2017seam|v2|v3|
|---|---:|---:|
| h3-4mean abs jump |44.323|30.887|
| h3-4P95abs jump |125.685|104.968|
| h3-4max abs jump |980.470|289.760|
| h3-4mean delta error vs actual |27.339|13.322|
| h6-7mean abs jump |35.372|36.700|
| h6-7mean delta error vs actual |18.347|19.422|

The bridge reduces the targeted seam but shifts some transition cost toward h6-7; not hidden or tuned away. July4origin11h example: h3/h4 from993.9/1201.3(+207.4kW) to1042.2/1069.8(+27.6kW), actualdelta+9.4kW. Improved but not perfect; point error may still be large. Smoothness not a substitute for accuracy. Contract1.2unchanged; threeexports rebuilt, current-hour/Agent fields preserved, no new LLMexportcalls. Floor conservation unchanged. Model_card updated from index/cache.

|h|n|v3coverage%|v3all MAE|v3reject%|v2coverage%|v2MAE|v2reject%|
|---:|---:|---:|---:|---:|---:|---:|---:|
|1|8759|90.38|11.592|16.18|90.38|11.592|16.18|
|2|8758|88.90|17.729|19.16|88.90|17.729|19.16|
|3|8757|90.87|20.509|20.54|88.07|19.608|18.56|
|4|8756|91.20|22.315|20.58|89.02|29.567|19.37|
|5|8755|91.03|24.754|19.68|89.11|29.848|19.68|
|6|8754|90.55|28.166|18.56|88.55|30.557|19.05|
|7|8753|88.16|31.629|17.59|88.16|31.629|17.59|
|8|8752|87.76|31.587|17.47|87.76|31.587|17.47|
|9|8751|87.62|31.694|17.04|87.62|31.694|17.04|
|10|8750|87.86|31.931|16.97|87.86|31.931|16.97|
|11|8749|88.06|32.261|17.01|88.06|32.261|17.01|
|12|8748|87.61|32.628|16.94|87.61|32.628|16.94|
|13|8747|88.63|33.783|18.63|88.63|33.783|18.63|
|14|8746|88.69|33.764|18.71|88.69|33.764|18.71|
|15|8745|88.86|33.768|18.50|88.86|33.768|18.50|
|16|8744|88.70|33.790|17.99|88.70|33.790|17.99|
|17|8743|88.97|33.815|18.09|88.97|33.815|18.09|
|18|8742|88.97|33.809|18.10|88.97|33.809|18.10|
|19|8741|88.90|33.861|18.38|88.90|33.861|18.38|
|20|8740|88.85|33.899|18.90|88.85|33.899|18.90|
|21|8739|88.65|33.975|18.95|88.65|33.975|18.95|
|22|8738|88.57|34.051|18.23|88.57|34.051|18.23|
|23|8737|88.63|34.133|18.29|88.63|34.133|18.29|
|24|8736|88.51|34.268|18.53|88.51|34.268|18.53|

## Real-mode/chat

Provider makes bounded structured calls: select one of forecast_peak/hvac_compare/unknown, host validates and executes existing tools, then provider organizes1-2Chinese sentences from rounded tool trace. Tool choice has no arbitrarycode/network execution. Unknown facts return不知道; refused what-if cost staysnull. Answer every numeric token must have a supplied numeric leaf, essential peak/time or comparison values required, comparison must say情景/非实测. One rewrite names unsupported numbers; invalidchoice/transport/grounding/format returns existing rule answer, llm_mode=rule with safe metadata. Demo/missingconfig never calls provider, unchanged rule route. Question/provider/tool content is data, not permission to loosen boundaries.

what-if baseline now uses row.agent.hvac_setpoint_c, held across future scenario. Compare requested temperature with that current plan setpoint, not fixed24C; other controlled assumptions unchanged zeroPV/battery, configuredtariff, origintemperaturepersistence. This does not know future changed schedules and does not claim calibrated savings.

Real probes: first returnedrule/chat_grounding_failed; second returnedrule/ReadTimeout/statusNone. Both faithfully fallback. After clarifying Chinese date formatting (no signed hyphen tokens) and essential value checking, third probe returnedreal/llm_tools,selected_tool=forecast_peak,grounded=True,call_succeeded. Only safe status metadata printed, no raw answer/key. Successfulrealwhat-if not separately network-probed; fake provider exercises that path. Numericmatching is not full semantic truthfulness proof. Key never logged or copied; only exception class/status recorded. Tests verify selectedtools, numeric correctivefeedback, fallback, current baseline, demo nonnetwork, real transport secret-safe failure, past-onlyforecast/labelperturbations and all-step metric reproduction.
