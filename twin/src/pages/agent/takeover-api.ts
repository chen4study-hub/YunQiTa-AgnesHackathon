export type StorageMode = "idle" | "charge" | "discharge";
export interface Recommendation {
  available: boolean;
  message?: string;
  recommendation_hash?: string;
  duration_hours?: number;
  hvac_setpoint_c?: number;
  storage_mode?: StorageMode;
  storage_power_kw?: number;
  reason?: string;
}
export interface Takeover {
  id: string;
  version: number;
  date?: string;
  hour?: number;
  start_at: string;
  end_at: string;
  start_ms: number;
  end_ms: number;
  hvac_setpoint_c: number;
  storage_mode: StorageMode;
  storage_power_kw: number;
  operator_id: string;
  reason: string;
  status: string;
  cancelled_ms?: number | null;
  record_status?: string;
}
export interface TakeoverInput {
  date: string;
  hour: number;
  duration_hours: number;
  hvac_setpoint_c: number;
  storage_mode: StorageMode;
  storage_power_kw: number;
  reason: string;
  operator_id: string;
  request_id: string;
  recommendation_hash?: string;
}
export class TakeoverError extends Error {
  constructor(
    message: string,
    public disconnected = false,
  ) {
    super(message);
  }
}
/** Always /api: no local state substitutes for a backend write. No POST retries. */
export async function takeoverRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 8000);
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json"))
      throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
    let data: Record<string, unknown>;
    try {
      data = await response.json();
    } catch {
      throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
    if (!response.ok)
      throw new TakeoverError(
        typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail ?? "接管请求失败"),
      );
    if (typeof data.api_version !== "string" || !data.api_version)
      throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
    return data;
  } catch (error) {
    if (error instanceof TakeoverError) throw error;
    throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
export function readRecommendation(
  data: Record<string, unknown>,
): Recommendation {
  if (typeof data.available !== "boolean")
    throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
  if (
    data.available &&
    (!Number.isFinite(data.hvac_setpoint_c) ||
      !Number.isFinite(data.storage_power_kw) ||
      !Number.isInteger(data.duration_hours) ||
      !["idle", "charge", "discharge"].includes(String(data.storage_mode)) ||
      typeof data.reason !== "string")
  )
    throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
  return data as unknown as Recommendation;
}
export function readTakeover(value: unknown): Takeover | null {
  if (value === null) return null;
  const d = value as Takeover;
  if (
    !d ||
    typeof d.id !== "string" ||
    !Number.isInteger(d.version) ||
    !Number.isFinite(d.start_ms) ||
    !Number.isFinite(d.end_ms) ||
    !Number.isFinite(d.hvac_setpoint_c) ||
    !Number.isFinite(d.storage_power_kw) ||
    !["idle", "charge", "discharge"].includes(d.storage_mode) ||
    typeof d.operator_id !== "string" ||
    typeof d.reason !== "string"
  )
    throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
  return d;
}
export type TakeoverFields = {
  duration: string;
  temp: string;
  mode: StorageMode | "";
  power: string;
  reason: string;
  operator: string;
};
/** Fill untouched controls once from the current recommendation, preserving payload precision. */
export function prefillTakeoverFields(
  fields: TakeoverFields,
  rec: Recommendation | null,
  touched: Partial<Record<keyof TakeoverFields, boolean>> = {},
): TakeoverFields {
  if (!rec?.available) return fields;
  const values: Partial<TakeoverFields> = {
    duration: String(rec.duration_hours),
    temp: String(rec.hvac_setpoint_c),
    mode: rec.storage_mode,
    power: String(rec.storage_power_kw),
  };
  const next = { ...fields };
  for (const key of ["duration", "temp", "mode", "power"] as const)
    if (!touched[key] && values[key] !== undefined)
      Object.assign(next, { [key]: values[key] });
  return next;
}
export function buildTakeoverInput(
  date: string,
  hour: number,
  fields: TakeoverFields,
  rec: Recommendation | null,
  request_id: string,
): TakeoverInput {
  const use = (s: string, v: unknown) =>
    s.trim() ? Number(s) : typeof v === "number" ? v : NaN;
  const duration_hours = use(
      fields.duration,
      rec?.available ? rec.duration_hours : undefined,
    ),
    hvac_setpoint_c = use(
      fields.temp,
      rec?.available ? rec.hvac_setpoint_c : undefined,
    ),
    storage_mode =
      fields.mode || (rec?.available ? rec.storage_mode : undefined),
    storage_power_kw =
      storage_mode === "idle"
        ? 0
        : use(
            fields.power,
            rec?.available && rec.storage_mode === storage_mode
              ? rec.storage_power_kw
              : undefined,
          );
  const reason =
      fields.reason.trim() || (rec?.available ? rec.reason : "") || "",
    operator_id = fields.operator.trim();
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(duration_hours) ||
    duration_hours < 1 ||
    duration_hours > 24 ||
    !Number.isFinite(hvac_setpoint_c) ||
    hvac_setpoint_c < 24 ||
    hvac_setpoint_c > 27 ||
    !storage_mode ||
    !Number.isFinite(storage_power_kw) ||
    storage_power_kw < 0 ||
    storage_power_kw > 500 ||
    (storage_mode !== "idle" && storage_power_kw === 0) ||
    !reason ||
    !operator_id
  )
    throw new TakeoverError("请填写完整的有效配置、原因和操作人");
  return {
    date,
    hour,
    duration_hours,
    hvac_setpoint_c,
    storage_mode,
    storage_power_kw,
    reason,
    operator_id,
    request_id,
    ...(rec?.recommendation_hash
      ? { recommendation_hash: rec.recommendation_hash }
      : {}),
  };
}

/** Only persisted active records cover current decisions; cancellation is a notice, never an overlay. */
export function takeoverCovers(
  record: Takeover | null,
  date: string,
  hour: number,
): boolean {
  const at = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`);
  return (
    !!record &&
    (record.record_status ?? record.status) === "active" &&
    record.start_ms <= at &&
    record.end_ms > at &&
    record.cancelled_ms == null
  );
}
export interface ReceiptCommand {
  created_at?: string;
  destination: string;
  command: { setpoint_c?: number; battery_kw?: number };
  effective?: boolean;
  source?: string;
}
export interface ServiceReceipt {
  source: "manual" | "agent";
  actions: string[];
  records: ReceiptCommand[];
  count: number | null;
  elapsed: number | null;
  written_at?: string;
}
export function readServiceReceipt(
  data: Record<string, unknown>,
): ServiceReceipt {
  if (data.source !== "manual" && data.source !== "agent")
    throw new TakeoverError("回执暂不可用");
  const rows = Array.isArray(data.records) ? data.records : [];
  const records = rows.flatMap((entry) => {
    const row = entry as ReceiptCommand;
    if (
      !row ||
      !["BA", "EMS"].includes(row.destination) ||
      !row.command ||
      typeof row.command !== "object"
    )
      return [];
    const value =
      row.destination === "BA"
        ? row.command.setpoint_c
        : row.command.battery_kw;
    return typeof value === "number" && Number.isFinite(value)
      ? [
          {
            destination: row.destination,
            command:
              row.destination === "BA"
                ? { setpoint_c: value }
                : { battery_kw: value },
            effective: row.effective,
            source: row.source,
            created_at:
              typeof row.created_at === "string" ? row.created_at : undefined,
          },
        ]
      : [];
  });
  const receipt =
    data.receipt && typeof data.receipt === "object"
      ? (data.receipt as Record<string, unknown>)
      : {};
  return {
    source: data.source,
    actions: Array.isArray(data.actions)
      ? data.actions.filter((a): a is string => typeof a === "string")
      : [],
    records: sortReceiptCommands(records),
    written_at:
      typeof data.created_at === "string"
        ? data.created_at
        : typeof receipt.created_at === "string"
          ? receipt.created_at
          : undefined,
    count:
      typeof receipt.count === "number" && Number.isFinite(receipt.count)
        ? receipt.count
        : null,
    elapsed:
      typeof receipt.elapsed_ms === "number" &&
      Number.isFinite(receipt.elapsed_ms)
        ? receipt.elapsed_ms
        : null,
  };
}
export const auditActions: Record<string, string> = {
  create: "创建接管",
  update: "修改接管",
  cancel: "撤销接管",
  expire: "接管到期",
  view_receipt: "查看执行回执",
};
export interface HistoryRow {
  created_at?: string;
  cancelled_at?: string | null;
  id: string;
  start_at: string;
  end_at: string;
  operator_id: string;
  reason: string;
  status: string;
  hvac_setpoint_c: number;
  storage_mode: StorageMode;
  storage_power_kw: number;
}
export interface AuditRow {
  id: string | number;
  occurred_at: string;
  operator_id: string;
  action: string;
  before: unknown;
  after: unknown;
}
/** Whitelist only user-facing controls; never render entire backend objects or provenance. */
export function controlSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "暂无数据";
  const d = input as Record<string, unknown>,
    parts: string[] = [];
  if (
    typeof d.hvac_setpoint_c === "number" &&
    Number.isFinite(d.hvac_setpoint_c)
  )
    parts.push(`温控 ${d.hvac_setpoint_c.toFixed(1)} °C`);
  const names: Record<string, string> = {
    idle: "待机",
    charge: "充电",
    discharge: "放电",
  };
  if (typeof d.storage_mode === "string" && names[d.storage_mode])
    parts.push(
      `储能 ${names[d.storage_mode]}${d.storage_mode === "idle" ? "" : typeof d.storage_power_kw === "number" && Number.isFinite(d.storage_power_kw) ? ` ${d.storage_power_kw.toFixed(1)} kW` : ""}`,
    );
  if (typeof d.reason === "string") parts.push(d.reason);
  return parts.join(" · ") || "暂无数据";
}

const operatorKey = "yunqi-takeover-operator-v1";
export function rememberedOperator(): string {
  try {
    return typeof window === "undefined"
      ? ""
      : (window.sessionStorage.getItem(operatorKey) ?? "");
  } catch {
    return "";
  }
}
export function rememberOperator(value: string): void {
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(operatorKey, value.slice(0, 100));
  } catch {
    /* Disabled storage leaves the current form usable. */
  }
}

export function takeoverInterval(
  start: string,
  end: string,
  date: string,
): string {
  const format = (value: string) => {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
    if (!match) return "时间暂无数据";
    const days = Math.round(
      (Date.parse(`${match[1]}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
        86400000,
    );
    const prefix =
      days === 0
        ? ""
        : days === 1
          ? "次日 "
          : days === -1
            ? "昨日 "
            : `${match[1]} `;
    return prefix + match[2];
  };
  return `${format(start)}–${format(end)}`;
}

const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
export function sortReceiptCommands(rows: ReceiptCommand[]): ReceiptCommand[] {
  const priority = (r: ReceiptCommand) =>
    r.effective === true ? 0 : r.effective === false ? 2 : 1;
  return [...rows].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      (timestamp(b.created_at) ?? -Infinity) -
        (timestamp(a.created_at) ?? -Infinity) ||
      0,
  );
}
export function sortTakeoverHistory(rows: HistoryRow[]): HistoryRow[] {
  return [...rows].sort(
    (a, b) =>
      (timestamp(b.created_at) ?? -Infinity) -
        (timestamp(a.created_at) ?? -Infinity) || 0,
  );
}
/** Database event times are UTC; present them in the API's Shanghai timezone, not source-file time. */
export function recordEventTime(value: unknown, date: string): string {
  const ms = timestamp(value);
  if (ms === null) return "时间暂无数据";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const p = (name: string) => parts.find((x) => x.type === name)?.value ?? "";
  const eventDate = `${p("year")}-${p("month")}-${p("day")}`,
    clock = `${p("hour")}:${p("minute")}`;
  const days = Math.round(
    (Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
      86400000,
  );
  return (
    (days === 0
      ? ""
      : days === 1
        ? "次日 "
        : days === -1
          ? "昨日 "
          : `${eventDate} `) + clock
  );
}

export interface CancelledTakeover {
  id: string;
  cancelled_at: string;
  operator_id: string;
}
/** Cancellation events, not current wall time or expiry, are the persisted evidence. */
export function latestHourCancellation(
  items: unknown[],
  date: string,
  hour: number,
): CancelledTakeover | null {
  const at = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`);
  const matches = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>,
      start =
        typeof r.start_ms === "number" ? r.start_ms : timestamp(r.start_at),
      end = typeof r.end_ms === "number" ? r.end_ms : timestamp(r.end_at),
      cancel = timestamp(r.cancelled_at);
    if (
      typeof r.id !== "string" ||
      start === null ||
      end === null ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !(start <= at && at < end) ||
      cancel === null ||
      typeof r.cancelled_at !== "string"
    )
      return [];
    const operator =
      typeof r.cancelled_by === "string" && r.cancelled_by.trim()
        ? r.cancelled_by
        : "暂无数据";
    return [{ id: r.id, cancelled_at: r.cancelled_at, operator_id: operator }];
  });
  return (
    matches.sort(
      (a, b) => Date.parse(b.cancelled_at) - Date.parse(a.cancelled_at),
    )[0] ?? null
  );
}
export async function readHourCancellation(
  date: string,
  hour: number,
  signal?: AbortSignal,
): Promise<CancelledTakeover | null> {
  const items: unknown[] = [];
  for (let offset = 0; ; offset += 200) {
    const result = await takeoverRequest(
      `/takeover/history?date=${encodeURIComponent(date)}&limit=200&offset=${offset}`,
      undefined,
      signal,
    );
    if (!Array.isArray(result.items))
      throw new TakeoverError("接管历史暂不可用");
    items.push(...result.items);
    if (result.items.length < 200) break;
  }
  return latestHourCancellation(items, date, hour);
}

/** Current UI state follows the persisted lifecycle, not /active's historical manual alias. */
export function takeoverIsActive(
  record: Takeover | null,
  date: string,
  hour: number,
): boolean {
  return (
    !!record &&
    (record.record_status ?? record.status) === "active" &&
    takeoverCovers(record, date, hour)
  );
}
