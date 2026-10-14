# May anomaly diagnosis — no retuning

All three candidates have elevated May errors: replayMAE45.746,expandedMAE44.116,XGBoostMAE104.665. Actual values have no missing hours. No rows removed or corrected.

The shared worst day is2017-05-09: daily MAE315.58/392.33/333.97 for replay/expanded/XGBoost. Meter readings switch from1483.782 at09h to382.992 at10h,390.992 at11h,1742.361 at12h,670.920 at13h,1816.289 at15h and458.486 at16h. Such alternating jumps make lag-based one-step forecasting difficult. This is evidence of abrupt measured-load behavior, NOT proof of sensor corruption or a particular equipment event. Meter-cleaning source and operational logs are needed to distinguish an actual regime change from data artifacts.

For2017-only models, lagged-weather training range is[-22.8,18.3]C;192/744May hours lie outside it. Replay errors are64.71 in OOD versus39.15 in-range. But XGBoost errors are100.15 in OOD versus106.24 in-range: its May pathology cannot simply be blamed on weather extrapolation. XGBoost mean prediction bias is+75.21, and second-half MAE115.03 exceeds first-half93.61. PersistenceMAE43.67 is much better than XGBoost104.67. The evidence points to broad model residual overcorrection plus abrupt load transitions, with weather drift relevant but not sufficient.

Historical expanded data reduces overall seasonal error but does not solve abrupt May9 transitions; it is actually worse on that day. This disadvantage remains in pooled model-card metrics. XGBoost is parked; no optimization, new candidate selection, cleaning or test-driven parameter changes performed. Results reproducible with scripts/diagnose_may.py and saved monthly predictions, detailed receipt may_diagnosis.json.
