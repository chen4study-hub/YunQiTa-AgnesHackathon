# Holiday calibration research v1 — no promotion

## Frozen protocol

Plan `holiday_calibration_v1_plan.json` written before experiments. Baseline pooled28 is existing holiday-expanded LightGBM/CQR. Holiday is already present in the point, scale and quantile feature matrices. Two candidates: pooled90 (90day calibration) and holiday90 (same90day model; separate holiday/nonholiday Cq rank references, gate threshold and CQR residual quantile, minimum24group hours otherwise pooled fallback). Point-training end shifts earlier with90day calibration, so this is a whole-window comparison, not an isolated scale-only causal ablation. Holiday grouping changes both routing and interval calibration.

Development: monthly rolling July-December2016, each fit before its calibration and each calibration before its target month; 6holiday dates/144hours. Candidate chosen from2016 only; selection artifact written before2017 predictions. Target90.5%retained coverage in both groups plus ordinary rejection no more than baseline+2percentage points. Neither candidate passed. Predeclared fallback chose smallest summed coverage deficit among candidates: holiday90. This is a failed-gate research candidate, not an approved solution.

Final: one frozen January-December2017 rolling evaluation of holiday90; no second evaluation or post-result tuning. Baseline uses original monthly cached predictions.2017 was already studied in previous work: this is NOT a never-seen blind holdout, despite new candidate decisions restricted to2016. The results are empirical, with only10holiday dates; hourly counts are not independent holiday replicates.

## Development results (%)

| Method | Holiday rejection | Holiday retained coverage | Ordinary rejection | Ordinary retained coverage |
|---|---:|---:|---:|---:|
| pooled28 |38.89|87.50|15.24|90.61|
| pooled90 |33.33|83.33|15.05|91.10|
| holiday90 |19.44|84.48|15.64|91.12|

Reduced holiday rejection exposed harder retained hours; development holiday coverage worsened. Choice followed the predefined fallback among the two research candidates, not a claim of improvement over baseline.

## Once-only2017 results (%)

| Method | Holiday rejection | Holiday retained coverage | Ordinary rejection | Ordinary retained coverage |
|---|---:|---:|---:|---:|
| original pooled28 |33.75|88.68|15.67|90.42|
| frozen holiday90 |21.67|88.83|20.83|91.52|

Holiday rejection improves12.08percentage points (retained159→188/240hours), but coverage only+0.15pp and still below90.5%. Ordinary rejection worsens5.16pp while coverage rises1.10pp (retained7185→6745/8520). Neither development nor final supports shipping a reliable holiday coverage fix. Keep existing demo model, registry, routes and replay exports unchanged. No new LLM calls/exports this round. Artifacts contain per-month prior-window dates, group fallback counts, widths and pooled metrics; tests recompute the pooled counts/coverage from those rows.

Limitation: minimum24hours is only one prior holiday; roughly31.5day Cq inside90day calibration often has no holiday, causing pooled fallback. Grouping is sparse and does not guarantee conditional coverage. A better future approach needs more historical holiday years, causal scale diagnostics and an independently frozen final period; do not tune2017 again here.

## Grounding retry

Added exact numeric-token diagnostics. Rewrite prompt now names the tokens without matching numeric leaves and asks to remove them or use supplied values; it does not compute substitute numbers or relax grounding. Candidate evidence renders actions in Chinese (保持设定/提前预冷/储能调度/转人工), retains one-decimal evidence; original controls remain full precision. Reasons containing hold/dispatch/precool/human_review are rejected and receive explicit corrective feedback. Offline retry tests prove an unsupported999.9 is identified and corrected; no claim yet of reduced real replay fallback count. Existing72hour exports remain untouched until later joint export.

## Peak threshold1194.8→1183.2

Both are past-training load P80, not model risk thresholds. April bundle: training2016-01-20 through2017-03-03,9816hours,P80=1194.795. July bundle: through2017-06-02,12000hours,P80=1183.1648. October bundle: through2017-09-02,14208hours,P80=1186.8466. All recomputed from adapted raw target observations and match saved bundles.

Old `peak_threshold_from_train` provenance used the loop variable after normal,peak,abstain, thus the LAST scenario's threshold: oldApril9abstain produced April1194.8; newJuly4abstain produced July1183.2. The July peak's real agent threshold was already July1183.2; no manual retuning took place. Coincidental alignment concealed this ambiguous scalar. Exporter now writes legacy scalar explicitly from peak plus `peak_threshold_by_scenario` (month,threshold,train_end). This round does not regenerate provenance/exports; next export fixes the receipt metadata. Evidence: b3260f3 replay_selection.json and prepare_demo_monthly.py train.y.quantile(.8).
