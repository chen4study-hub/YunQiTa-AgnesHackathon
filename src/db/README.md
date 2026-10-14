# Yunqi takeover database

Uses Python `sqlite3` only. No changes to Agent planning, operations providers or frontend assets.

## Configuration and startup

- Path precedence: `YUNQI_DB_PATH`, then `DATABASE_URL` (`sqlite:///` only), then repository-relative `data/yunqi.db`.
- WAL, foreign keys and a 5-second busy timeout are enabled. Writes use `BEGIN IMMEDIATE` and roll back together.
- Router startup applies ordered SQL migrations from `migrations/`. `schema_version` records filename, SHA-256 and application time; changed applied migrations fail startup.
- Do not put credentials in database configuration or records. Operator IDs are attribution supplied by the caller, **not authenticated identities**. Protect the API behind trusted deployment authentication before exposing writes publicly.
- Back up a running WAL database with SQLite's backup API, not by copying the main file alone.

## Frontend contract

All successful responses contain `api_version: "1.0"`, `timezone: "Asia/Shanghai"` and `Cache-Control: no-store`.

`date` is the displayed `YYYY-MM-DD`; `hour` is an integer 0–23. Source-file dates never identify a takeover. Intervals are whole display hours, end-exclusive, with 1–24 hours allowed (including crossing midnight).

### Recommendation

`GET /takeover/recommendation?date=2026-10-12&hour=10`

- `available`: whether a supported recommendation exists.
- If available: `hvac_setpoint_c`, `storage_mode` (`charge`, `discharge`, `idle`), `storage_power_kw` (nonnegative magnitude), signed `battery_kw`, `duration_hours`, `reason`, `candidate_id`, `basis`.
- `recommendation_hash`: optional optimistic check on submission.
- Provenance: `building_id`, `source_date`, `source_timestamp`, `source_key`, `export_sha256`, `model_version`.
- If unavailable: `available: false`, `message: "推荐暂不可用"`; no default temperature or power is supplied.

Reads the shared operations calendar and corresponding immutable hourly export. Executed hours use the selected candidate's matching plan command and Agent explanation. Handoff hours call `src.agent.manual_reference.manual_reference_at(agent, date, hour)` using the source timestamp `t`'s own local date and hour, **not** the display date or a Shanghai-converted hour. `agent.manual_reference` is an array: the main hourly export contains only that hour's reference (empty on executed hours), while the companion can contain the entire segment. A matching reference supplies `hvac_setpoint_c`, `storage_mode`, signed `battery_kw` (positive discharge), `reason` and `remaining_duration_hours`; the API maps absolute power to `storage_power_kw` and remaining hours to `duration_hours`. Missing match or required fields returns unavailable, with no work-order or fixed-value fallback. No model calls or automatic dispatch are made.

Frontend placeholders must use these returned values. For idle storage, show a mode label rather than inventing nonzero power. Existing exports can legitimately return the same temperature or zero signed power; values are not fabricated to vary. A placeholder is not a submitted value.

### Create and state

`POST /takeover` body:

```json
{
  "date": "2026-10-12",
  "hour": 10,
  "duration_hours": 2,
  "operator_id": "值班员甲",
  "hvac_setpoint_c": 25.2,
  "storage_mode": "idle",
  "storage_power_kw": 0,
  "reason": "核对设备后调整温控",
  "request_id": "client-generated-unique-id"
}
```

`recommendation_hash` is optional; only checked if sent. An unavailable recommendation does not prohibit explicit, valid operator controls; its unavailable snapshot is still saved. `request_id` is optional and idempotent for identical submissions; reuse for different controls returns 409.

Controls are checked against 24–27 °C, 500 kW and any tighter equipment limits. Charge/discharge magnitude must be positive, idle must be zero. Nonzero power requires valid starting SOC and full-duration SOC bounds. All covered hours must have mapped evidence. NaN/infinity and invalid times are rejected.

Response: `{takeover: {...}}`. Record fields include `id`, `version`, `start_at`, `end_at` (Shanghai offset), `start_ms`, `end_ms`, controls, `operator_id`, `reason`, `status`, cancellation fields and `recommendation_snapshot`.

`GET /takeover/active?date=&hour=` returns `{takeover: null}` or a display record. Uncancelled records use `status: "manual"`, with original lifecycle in `record_status`. A cancellation later than the queried hour start remains visible, but uses `status: "cancelled"` and includes `cancelled_at`, `cancelled_by`, and `cancel_reason`. Frontend may show “本小时人工接管已撤销” with event time and operator; it must not apply a cancelled record as a decision override.

Display history uses `start <= hour_start < end` and cancellation either absent or strictly later than the hour start. Decision queries (`get_active_takeover`, schedule and question lookup) only accept **uncancelled** records, regardless of whether cancellation happened after the hour start. Cancellation immediately restores the original decision path without changing forecast gates or creating work orders. Expiry uses server time and does not erase an uncancelled record's past-hour coverage.

`POST /takeover/{id}/cancel`: `{operator_id, reason, expected_version?}`. Same cancellation is idempotent. Cancellation never deletes a prior receipt. Conflict checks only consider uncancelled records: a new takeover can reuse the same display hour immediately after cancellation. Both decision lookup and `/takeover/active` prefer the new uncancelled record; history and audit retain the cancelled one.

`PATCH /takeover/{id}`: full create-body fields plus required `expected_version`. Only not-yet-started active records can be changed. For a started record, cancel and create a new interval. Original receipt rows remain, with `effective: false` when superseded.

`GET /takeover/history?date=&limit=100&offset=0`: `{items: [...]}`, includes intervals intersecting that display date.

### Receipt and audit

`GET /dispatch/receipt?date=&hour=&operator_id=`:

- Database rows first; otherwise the mapped hourly Agent `actions` and `receipt`, with `source: "agent"`.
- Database response: `source`, `records` (BA/EMS commands, receipt, batch, takeover/version, `effective`), aggregate `receipt`, `active_takeover`.
- A takeover creates two manual database log records per covered hour in the same transaction. They are log records, **not site-device acknowledgements**: `transport: "log_only"`, `device_connected: false`, `status: "recorded"`.
- Cancelled/superseded logs remain visible. Use `effective` and `active_takeover`, not log existence, to determine coverage. Manual creation records no measured SOC or changed meter readings.
- Viewing a receipt records the supplied operator and returned values in the audit log.

`GET /audit?date=&limit=100&offset=0`: `{items: [...]}`. Without `entity_type`, only `takeover` and `receipt` records are returned, so the Agent operation log never includes question events. Explicit filters support `entity_type=takeover`, `receipt`, or `chat`; filtering happens before pagination. Audit dates are event times in Shanghai, not the takeover target date. Audit rows are append-only.

Backend-only question inspection: `GET /audit?date=2026-10-13&entity_type=chat`. Do not display these records in the frontend. The filter is not authentication; deployments must restrict access to this sensitive query through backend authorization. Original questions may contain sensitive text.

`from src.db import record_chat_event` provides `record_chat_event(session_id, question, classification, reason, *, operator_id='system', request_id=None) -> int`. It opens its own transaction and returns the inserted audit ID. `entity_type='chat'`, `action='chat_terminated'`, `entity_id=session_id`; `after` contains server UTC `occurred_at`, `session_id`, the verbatim `question`, `classification`, and `reason`. Caller supplies the classification (e.g. `politics` or `current_affairs`); this function does not classify or terminate sessions itself. Exceptions propagate, and failed writes roll back. No new migration is needed.

`Repository.audit(..., *, entity_type=None)` keeps its prior default mapping (`view_receipt` to `receipt`, other actions to `takeover`) when the new argument is omitted.

Errors: 404 missing record; 409 overlap/version/hash conflict; 422 invalid controls/date/time; 503 missing export or unavailable database. Unsupported date coverage does not silently choose another day.

## Model-session integration

```python
from src.db import get_active_takeover
manual = get_active_takeover(display_date, hour)
```

Returns `None` for every cancelled record, or an uncancelled manual/record-status object. This is deliberately different from the display API's cancellation-history result. Read it before automatic dispatch; manual controls must replace the covered-hour command and response `status`, not the underlying forecast confidence. Do not dispatch Agent commands first and merely relabel the response. Recheck cancellation/version at the final dispatch boundary.

`Repository.record_agent_dispatch(date, hour, building_id, commands, receipt, request_id)` stores an existing log-only Agent BA/EMS receipt idempotently. `commands` is a list of `{destination: "BA", command: {setpoint_c: ...}}` and `{destination: "EMS", command: {battery_kw: ...}}`. It does not call equipment.

The scheduling and question integrations are separate work: this module does not modify `src/agent` or the existing schedule handler. Adding the router exposes persistence endpoints but does not itself change automatic schedules or answers.

## Multiple tabs / disconnected deployment

Poll `/takeover/active` every 3 seconds in visible tabs, and immediately on focus, date/hour change or successful writes. State always comes from the shared backend; persist no local substitute for a successful takeover. On writes, include versions for optimistic concurrency.

A static frontend must verify JSON content and `api_version`; a 200 HTML fallback is not a connected backend. On failure disable takeover writes and show “接管服务未连接”.

## Verification

```text
python -m pytest tests/db -q
python tests/db/probe_http.py
python -m src.db.standalone --port 8127
```

Tests use temporary databases. The HTTP probe starts, restarts and stops only its own loopback subprocess on a free port above 8100, proving persistence across restart without touching the resident service. The standalone command also uses a temporary database.
