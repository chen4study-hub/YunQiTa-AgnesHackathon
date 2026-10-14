# 2017 monthly rolling assessment

Task AgnesHackathon_Monthly2017 ran in background, exit0; disabled after completion to prevent duplicate runs. Log: logs/monthly_backtest.log. 30 completed month/candidate pairs,6 early-month skips. Replay CQR and XGBoost only have2017 data: Jan-Mar insufficient prior training/calibration, explicitly skipped. Expanded holiday candidate has usable2016 history and completed all12 months. Calibration is the preceding28days, training strictly earlier; monthly features use preceding observed loads only. Hyperparameters unchanged, no retuning or replay model replacement.

Comparable Apr-Dec simple monthly means (not pooled coverage):

| Candidate | All MAE | Retained PICP | Actual rejection | Interval score |
|---|---:|---:|---:|---:|
| Replay LightGBM CQR | 16.975 | 91.48% | 20.93% | 143.980 |
| Expanded holiday LightGBM CQR | 12.589 | 90.93% | 17.19% | 121.468 |
| XGBoost static | 32.389 | 79.22% | 29.90% | 14808.366 |

Expanded history improves error and rejection on average, but not every month/holiday. XGBoost interval instability is severe: December retained36/744hours, rejection95.16%, retained coverage75%, interval score129891.435. Do not hide it behind a low retained MAE. Investigating/tuning that pathology is outside this finalization request.

Observed federal-holiday hours:168 for2017-only candidates (7 dates),240 for expanded candidate (10 dates). Calendar remains a US federal observed-day proxy, not verified building closures. These historical data include previously inspected periods; the rolling chronology is causal, but results are not a new blind test. Null holiday retained metrics mean no retained hours, not zero error or guaranteed coverage.

CSV: monthly_backtest_metrics.csv; full row, chronology, holiday and source-cache receipts: monthly_backtest_results.json; incremental recovery: monthly_backtest_checkpoint.json. Raw/model files not uploaded. No twin/ edits.
