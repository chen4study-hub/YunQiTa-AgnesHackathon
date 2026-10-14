# Origin-causal direct24 monthly evaluation

## Protocol and weather trade-off

Frozen before run: `multi_horizon_v1_plan.json`; one pooled LightGBM residual point model plus lower/upper quantile models with horizon feature (1–24). Fixed150trees/0.05/31leaves/seed42, no2017parameter search. Training history begins2016-01-20. December2016warm-up supports January confidence;2017monthly origins evaluated once.2017was previously studied for1step, not a never-seen blind holdout. No promotion of legacy champion, POST routes or1step demo model.

Features known at issue time t: load(t),t−1,t−24,t−168, inclusive past rolling means, origin disagreement, seasonal anchor load(t+h−24), target calendar/holiday (known in advance), and weather(t) past-forward-filled. Weather is **persistence at origin**, not target observed weather. It is causal and requires no weather API, but ignores changing future temperatures;24h persistence can miss fronts/heat waves. Climate-average option was not searched or selected on2017. Missing historic weather staysNA until a past value exists; never backfilled from future.

Each monthly model is frozen before first origin. Calibration28days prior to origin month; point/quantile train labels target<calibration start. Scale learns actual point error only on first65%calibration, with targets before Cq start. Cq origins in final35%calibration and labels target<month start, separately for eachhorizon. Thus split gaps grow for longer horizons to keep all labels observed before the next fit boundary. This is stricter than origin-only split, which would leak late labels. Month-crossing forecasts use the origin month's model, not the target month's future fit.

CQR residual quantile per horizon on risk-gate-retained Cq; point always enclosed, lower>=0. Same alpha0.095, rho0.15, rank weights[0.70,0.15,0.10,0.05], higher quantile gate, min scale0.001 and max relative width1.0. Building/usage prior remains constant training residual mean for this single building. Every horizon has its own prior-only Cq reference/gate. No threshold relaxed based on2017coverage.

Confidence uses horizon-specific previous completed-month empirical risk-decile isotonic coverage with existing99%empirical+1%inverse-risk tie break and full-gate width penalty. Prior-month forecasts whose target was not observed by fit time are excluded. Rejection iff confidence<per-step confidence_threshold; score is NOT guaranteed conditional probability. CQR intervals are marginal per step, not90.5%joint24step path coverage.Overlapping origins/targets are not independent samples.

## Results

Each horizon issued8760forecasts. Metrics only use observed labels: n=8760−h because2018actuals unavailable. Forh24the last24origins lack target labels; the plan's informal “last23” phrase meant the final incomplete tail but the exact implemented rule is target-label availability. All predictions still generated for those origins; excluded from coverage/MAE/rejection denominators only. Retained coverage pooled retained hits/retained hours; MAE below is all observed samples; persistence baseline point=load(t), no fitted baseline interval.

No horizon reaches90.5%retained coverage. Newh1MAE31.51 is worse than prior independent1step model all-MAE11.59, so don't claim this shared direct model upgrades1step quality. It supports a causal24h path with demonstrable uncertainty limitations; future improvements require newly frozen development experiment, not tuning these2017results. Table generated from saved index/cache evidence.

| h | observed n | retained coverage % | all MAE | retained MAE | rejection % | persistence MAE |
|---:|---:|---:|---:|---:|---:|---:|
|1|8759|88.78|31.510|30.026|15.57|31.868|
|2|8758|88.49|31.624|30.668|15.16|60.352|
|3|8757|88.22|31.739|30.287|14.96|87.350|
|4|8756|88.01|31.904|30.558|15.14|114.391|
|5|8755|88.09|32.008|31.003|15.05|139.921|
|6|8754|87.82|32.181|30.452|15.68|163.568|
|7|8753|87.76|32.363|30.925|16.11|185.966|
|8|8752|87.73|32.517|30.690|16.29|205.387|
|9|8751|87.73|32.619|31.372|16.25|222.175|
|10|8750|87.74|32.679|31.574|16.46|234.715|
|11|8749|87.75|32.739|31.854|17.03|243.899|
|12|8748|87.66|32.808|31.501|17.03|247.224|
|13|8747|87.66|32.843|31.759|16.41|246.659|
|14|8746|87.42|32.899|32.415|17.08|240.722|
|15|8745|87.72|33.060|32.151|16.56|231.634|
|16|8744|87.43|33.152|32.325|16.22|218.732|
|17|8743|87.27|33.241|32.966|16.02|203.818|
|18|8742|87.38|33.326|32.831|16.40|186.926|
|19|8741|87.61|33.328|32.532|16.46|168.547|
|20|8740|87.69|33.360|32.419|16.36|149.231|
|21|8739|87.65|33.419|33.166|16.08|129.539|
|22|8738|87.68|33.481|33.449|16.10|109.803|
|23|8737|88.09|33.545|32.999|16.30|90.850|
|24|8736|88.17|33.599|32.919|16.67|78.833|

## Replay1.2

Each historical hour is an origin t. `recent_actual` contains t−1 andt actuals, including prior-day23h at midnight; `forecast_24h` contains24ordered targets t+1…t+24, bounds/confidence/abstain and per-horizon thresholds. Model provenance in meta.multi_horizon_model_version/forecast_weather. Original current-hour point/interval/Agent/storage/grid remain old1step historical records as requested; NOT current model’s h0/h1 and NOT evidence of new24step Agent optimization. No new LLM calls or secrets read by future-export script; Agent source counts preserved (normal14llm/10rule, peak10/14, abstain9/15). No previous_hours.

Same export attaches stable density/use curves and seeded±4%jitter to current point and each future point; integer0.1kW largest-remainder conservation exact. Equipment2F/39F added to schema uses. Rules remain synthetic estimates; `docs/floor_allocation.md`. Existing physical-looking storage/PV/grid remain simulated/derived and log-only dispatch has no hardware. Floor allocation does not improve model predictions.

Local artifacts `models/byron-direct24-monthly-v1-YYYY-MM.joblib` and `data/direct24/YYYY-MM.csv` have hashes bound in index. No raw/model/cache committed. Export receipt records new file hashes/no network. Causal perturbation tests change all future loads/weather and confirm identical feature/prediction inputs for fixed origin; label perturbation confirms issued outputs independent of y; all metrics recomputed from cache. A requested read-only subagent audit failed to run and is not claimed as independent review. Live24step POST endpoint and new Agent use of future path are not implemented in this export milestone.
