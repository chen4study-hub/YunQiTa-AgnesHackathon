# New-objective real Agent refresh and building-only HVAC auxiliary proxy

## Execution

72origin hours rerun through run_agent under upper_grid_peak_then_cost_v1 with current real provider configuration, versioned checkpoint and fingerprint. No reuse of older cached candidate selections. Two-step historical current/next1step inputs retained (not a newly validated24hcontroller); only current command sent to log. Energy forecasters/calibration/gates unchanged; selected/selection_reason/preferred match. Updated controls recompute SOC/grid and expose candidate tool evidence + llm_mode/llm. Old selection audit evidence remains historical, not attached to current decision.

| Scenario | LLM hours | Rule hours | Refused horizon bypass | Transport fallback | Grounding fallback | Objective fallback |
|---|---:|---:|---:|---:|---:|---:|
| normal |11|13|0|4|8|1|
| peak |10|14|4|5|5|0|
| abstain |6|18|13|1|3|1|
| total |27|45|17|10|16|2|

LLM mode requested real for all days; successfulsource=llm only validated realresponses. A rule hour caused by refused nextstep does not necessarily mean current hour itself rejected. No fabricated success or hidden timeout502. Failure numbers name checks/attempt reason are safe metadata, never raw provider response or credential.

normal14h now rule_hold25.5C/battery0, two-step energycost2632.3CNY/upper-gridpeak1126.3kW vs rulefull/conservative2753.3CNY/1212.8kW. No more pretending old24.5Cselection was preferable. Previous frontend1352.0/1306.7were one-hour locally generated comparison values; do not compare two-step newcost to one-hour previouscost. Frontend must use exported selected/candidates/selection_reason, not selected=rule_full. Backend session did not touchtwin.

## HVAC proxy frozen before2017outputs

Plan one preregistered candidate, saved before2016run. Engineering boundary excludes districtproduction (hypothesis, not proven meter wiring). Only building air-distributionfans and secondarypumps modeled. Coefficients0.04470201832676245cooling and0.020642017845394618heating use EnergyPlus equations; pressure/coiltemperature/fanhandledfraction are fixed scenario values not fetched empiricalByronparameters. No2017parameter selection.2016physicalclip plausibilitycheck before exportingnew2017outcome; no alternatecandidate.29.15%annual uncappedproxyshare,8663validhours,0clips; p05/p95hourshares12.74/45.81%, max64.85%. No hourlyofficepercentilerange claimed.

Sources:
- https://bigladdersoftware.com/epx/docs/9-6/engineering-reference/air-system-fans.html — fan power=flow*pressure/total_efficiency.
- https://bigladdersoftware.com/epx/docs/9-6/input-output-reference/group-pumps.html — flow/head/shaftfactor/motorefficiency, defaults179352Pa/1.282051.
- https://www.eia.gov/consumption/commercial/data/2018/ce/xls/e5.xlsx — office227billionkWhtotal,heating13/cooling23/ventilation63, ventilation27.75%andallHVAC43.61%. Different stock/annualboundary; plausibility context only, not Byronesimatingtruth or statisticalinterval. Fixedengineeringgate5-60%is not a source-prescribedinterval.

| 2017typicalday | OldCOP5dayproxyshare% | Frozennewproxyshare% | Currentcaps | pastfillhours | validhours |
|---|---:|---:|---:|---:|---:|
|normal|33.79|14.34|0|0|24|
|peak|99.35|41.01|0|9|24|
|abstain|99.25|44.69|0|3|24|

No tuning after observingtheseoutputs. Cap remains safetyguard, futurepath persistedoriginmeters and cappedtofuturepoint only. Electricalfloors HVAC/nonHVAC sum exactly in0.1kWunits; total predictionunchanged. Proxy not measuredHVACsubmeter, not calibratedcounterfactualsavings. Documentallsourceassumptions inhvac_meter_contract.md and meta.hvac_method, method_version differentiateschanged assumption while contractremains1.3.

## Reproduction

- Do not repeat check_hvac_auxiliary2016 on already-frozenoutput; it rejects overwrite. Developmentchecks and finalexports are different stages.
- export_agent_replay --max-hours12: resumes fingerprint-bound dedicatedcheckpoint, realprovider mode required, newLLMcalls/dispatchlogs authorized only for thisrefresh.
- export_future24 / make_replay_sample / report_hvac_integration: noLLMcall, thermalfilehashes verified, fieldscausal/missingexplicit.
- Old audit_agent_selection refuses overwritingnewselectedrecords. Old experiments/agent_selection_audit.json is earlier historical evidence only.
- No task scheduler/environmentconfigurationchange. Persistentbackend issue from priorround not solved or reactivated inthisrequest.
