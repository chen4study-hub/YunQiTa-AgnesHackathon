CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
CREATE TABLE takeovers (
    id TEXT PRIMARY KEY,
    building_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 86400000),
    timezone TEXT NOT NULL CHECK (timezone = 'Asia/Shanghai'),
    operator_id TEXT NOT NULL,
    hvac_setpoint_c REAL NOT NULL CHECK (hvac_setpoint_c BETWEEN 24 AND 27),
    storage_mode TEXT NOT NULL CHECK (storage_mode IN ('charge','discharge','idle')),
    storage_power_kw REAL NOT NULL CHECK (storage_power_kw BETWEEN 0 AND 500),
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','cancelled','expired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    cancelled_at TEXT,
    cancelled_ms INTEGER,
    cancelled_by TEXT,
    cancel_reason TEXT,
    recommendation_snapshot_json TEXT NOT NULL,
    request_id TEXT UNIQUE,
    CHECK ((storage_mode = 'idle' AND storage_power_kw = 0) OR
           (storage_mode IN ('charge','discharge') AND storage_power_kw > 0))
);
CREATE INDEX takeovers_window ON takeovers(building_id,start_ms,end_ms);
CREATE TABLE dispatch_log (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    building_id TEXT NOT NULL,
    hour_start_ms INTEGER NOT NULL,
    destination TEXT NOT NULL CHECK (destination IN ('BA','EMS')),
    source TEXT NOT NULL CHECK (source IN ('agent','manual')),
    takeover_id TEXT REFERENCES takeovers(id),
    takeover_version INTEGER,
    command_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX dispatch_hour ON dispatch_log(building_id,hour_start_ms,created_at);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    request_id TEXT
);
CREATE INDEX audit_time ON audit_log(occurred_at,id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
