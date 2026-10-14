# Short-horizon repair v2 — frozen2016 selection, once-only2017 evaluation

## Diagnosis and options

v1 already used y(t),y(t−1),y(t−24),y(t−168); it was not missing all latest load information. Its residual anchor was y(t+h−24), so h1 anchored y(t−23), not exactly t−24. All24horizons shared a residual model and no explicit latest23/167h or target-aligned weekly lag; short local dynamics competed with day-long seasonal residual fitting. This design diagnosis is supported by the following ablation, not proven unique cause of v1error.

Before any new2017candidate metrics: `multi_horizon_v2_plan.json` froze two candidates and selection rule. Both route h1 to original holiday-expanded1step CQR. For h2+ retain all original features, add latest y(t−23),y(t−167), target-aligned y(t+h−24)/y(t+h−168), latest-versus-daily-target disagreement; residual anchor y(t) for h2-3, seasonal daily target thereafter. Weather persists observedt, target calendar known, no future measured weather/load features. Options: latest_pooled shares h2-24model; latest_segmented fixed bands2-3/4-6/7-12/13-24. No test-driven blend or curve smoothing.

Development input physically clipped to2016. Six monthly rolling evaluations July-December2016, target labels only2016, strict point/scale/Cq label chronology, unchanged alpha0.095/rho0.15/max-width1.0/risk weights. Refit v1for this same development population; did not use stored2017v1values to choose. Eligible if h1-3pooled MAE improves10%, retained coverage>=87.5%, and h4-24MAE<=baseline×1.05.87.5%is a predeclared research screen, NOT90.5%coverage target or revised gate.

| 2016method | h1-3MAE | h1-3coverage% | h1-3reject% | h4-24MAE | h4-24coverage% | h4-24reject% |
|---|---:|---:|---:|---:|---:|---:|
| v1 |33.773|90.07|23.06|32.931|90.24|22.59|
| latest_pooled |22.142|91.34|16.70|31.719|89.32|19.51|
| latest_segmented |14.567|89.82|16.18|31.151|88.77|20.11|

Both eligible; selected latest_segmented for lower short MAE. Decision/hash written to disk before2017evaluation. Long coverage degraded in development; not omitted. Hyperparameters unchanged150trees/0.05/31leaves/seed42. Decision is research/product selection, not proof of universal quality.

## One-step口径 and boundary

At origin t, forecast_24h[0] targets t+1; it is NOT compared to current row point_kw(t). Same-month h1 now uses the exact original monthly backbone/quantile models/Cq/gate and original past-only confidence lookup. Its feature lag1 is y(t), lag24=y(t−23), lag168=y(t−167), rolling windows endt, weather_past=weather(t). Test compares every same-month2017h1 point/bounds/risk/refusal against legacy cache at targett+1, plus exported next-hour records including confidence. No heuristic copy from target actuals.

Across month boundary origin-month bundle is retained: target-next-month legacy row would use its new month fit/updated confidence, which is unavailable when forecasting before month starts. Thus those11within-year boundary origins can differ; cannot claim all-year equality or borrow future Cq outcomes to force it. h1still generated after final2017observed hour by appending blank target row, not2018observations. H1coverage/MAE differ slightly from legacy year metrics because origin-vs-target population excludes first target Jan1 00h and includes boundary old-bundle forecasts.

Checked current repository peak origin2017-07-20 15h: oldv1h1=1265.0,newh1=1281.8,next legacy16h point=1281.8. User-cited1289/1331could belong to another snapshot; not reproduced from current exports and not presented as verified current values.

## Frozen2017results

One new evaluation of the chosen architecture, no re-selection afterward. Existing h1artifacts reused, h2+fit prior monthly windows. Each step issues8760, observed n=8760−h; exclude missing2018target labels only from metrics. All coverage is empirical pooled retained hit/retained count, not independent trajectory/day uncertainty or joint24hcoverage guarantee. Previous study of2017means this is not never-seen blind validation.

h1MAE31.510→11.592 (−63.21%), h2 31.624→17.729 (−43.94%), h3 31.739→19.608 (−38.22%). h24worsens33.599→34.268 (+1.99%). All horizons remain below90.5%retained coverage; no claim of fixing coverage. Segment boundaries can introduce point-path discontinuity; no smoothing tuned after observing final results. Targets3and4also have real load changes, so smoothness alone is not forecast accuracy.

| h | observed n | retained coverage % | all MAE | rejection % | v1MAE |
|---:|---:|---:|---:|---:|---:|
|1|8759|90.38|11.592|16.18|31.510|
|2|8758|88.90|17.729|19.16|31.624|
|3|8757|88.07|19.608|18.56|31.739|
|4|8756|89.02|29.567|19.37|31.904|
|5|8755|89.11|29.848|19.68|32.008|
|6|8754|88.55|30.557|19.05|32.181|
|7|8753|88.16|31.629|17.59|32.363|
|8|8752|87.76|31.587|17.47|32.517|
|9|8751|87.62|31.694|17.04|32.619|
|10|8750|87.86|31.931|16.97|32.679|
|11|8749|88.06|32.261|17.01|32.739|
|12|8748|87.61|32.628|16.94|32.808|
|13|8747|88.63|33.783|18.63|32.843|
|14|8746|88.69|33.764|18.71|32.899|
|15|8745|88.86|33.768|18.50|33.060|
|16|8744|88.70|33.790|17.99|33.152|
|17|8743|88.97|33.815|18.09|33.241|
|18|8742|88.97|33.809|18.10|33.326|
|19|8741|88.90|33.861|18.38|33.328|
|20|8740|88.85|33.899|18.90|33.360|
|21|8739|88.65|33.975|18.95|33.419|
|22|8738|88.57|34.051|18.23|33.481|
|23|8737|88.63|34.133|18.29|33.545|
|24|8736|88.51|34.268|18.53|33.599|

## Export and checks

Contract remains1.2 unchanged. Three scenarios re-exported via shortfix24caches. Current legacy fields/Agent/storage/grid and recent actuals unchanged; future bounds/confidence/refusal recomputed, floor allocation regenerated using existing fixed rules. No LLM calls/key reads/network in export; source counts remain normal14llm/10rule,peak10/14,abstain9/15, not new calls. New model_card.multi_horizon records v2all-step numbers and v1comparison.

Tests recompute all metrics from hashed caches, enforce frozen selection and prior label times, perturb future loads/weather for direct/h1features and labels for outputs, compare same-month h1to original cache, and retain schema/temporal/floor conservation/source checks. No change to registry/champion/POST live path; no24stepAgent optimization. Local model/cache paths and hashes in multi_horizon_v2_index.json. Plan and decision written before final evaluation; originalv1evidence remains immutable.
