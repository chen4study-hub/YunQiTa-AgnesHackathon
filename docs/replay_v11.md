# Replay1.1 / automatic log dispatch

Product mode is auto. Accepted hours have agent.status=executed; rejected hours have handoff, empty actions and zero battery power. dispatch appends logs/dispatch.jsonl only: no device connection. POST schedule also uses auto log dispatch. This replaces the previous shadow-only product constraint, not the measured historical evaluation results.

Hourly confidence=clip(1-risk_score,0,1), six-decimal ranking score, NOT conformal coverage probability. risk_threshold comes from the original frozen Cq risk distribution at rho=.15; rejection still includes interval-width checks. alpha=.095 continues to describe the nominal interval target. SOC upper limit=.95.

meta.data_source attributes BDG2 and lists adaptations. simulated_fields/estimated_fields remain truthful machine-readable provenance; agent action text uses execution/log wording. source enum now permits mock. sample stays mock and handoff. PV/storage/grid are not measured equipment outputs. CC BY-SA4.0 notice and legal-code URL are in exports/replay/LICENSE.

exports/model_card.json uses real historical full-test metrics, not the selected three replay days. Cross-building coverage85.54% belongs to the separate2016 Robin local-calibration transfer trial, explicitly labeled; it is not the85-building global model or Byron coverage. Replay coverage remains below90.5%, regardless of automatic log dispatch mode. Current replay model remains byron2017-v1-cqr; holiday candidate is separately routed for POST.

No twin/ files are edited by this change.
