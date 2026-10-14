import { validateOps } from "../validators/ops";
import { validationErrorsText } from "../validators/types";
import {
  OPS_DAY_MS,
  OPS_HOUR_MS,
  type OpsCalendar,
  type OpsCalendarDay,
  type OpsDay,
  type OpsFetch,
  type OpsFloorsFile,
  type OpsHour,
} from "./model";

const valid = validateOps;
function contract<T extends { kind: string }>(
  input: unknown,
  kind: T["kind"],
): T {
  if (!valid(input) || (input as T).kind !== kind)
    throw new Error(`Ops ${kind} contract: ${validationErrorsText(valid.errors)}`);
  return input as T;
}
function offsets(rows: { offset_ms: number }[], start: number, count: number) {
  if (
    rows.length !== count ||
    rows.some((r, i) => r.offset_ms !== start + i * OPS_HOUR_MS)
  )
    throw new Error("Ops hour offsets must be ordered and complete");
}
export interface OpsWindowHour {
  date: string;
  scenario: OpsCalendarDay["scenario"];
  at_ms: number;
  end_ms: number;
  hour: OpsHour;
}
export interface OpsWindow {
  start_ms: number;
  end_ms: number;
  // Full, date-bound days retain elevator left anchors and all event offsets.
  days: { date: string; data: OpsDay }[];
  hours: OpsWindowHour[];
}
export interface OpsLoaderOptions {
  baseUrl?: string;
  fetch?: OpsFetch;
}

/** Shared by pages and 3D. Failed loads are evicted; returned data is isolated. */
export function createOpsLoader(options: OpsLoaderOptions = {}) {
  const base = (options.baseUrl ?? "/replay").replace(/\/$/, "");
  const request: OpsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  let calendarPending: Promise<OpsCalendar> | undefined;
  const files = new Map<string, Promise<OpsDay>>();
  async function response(name: string) {
    const result = await request(`${base}/${name}`, { cache: "no-cache" });
    if (!result.ok) throw new Error(`Ops load ${name}: HTTP ${result.status}`);
    return result;
  }
  function calendarRaw() {
    if (!calendarPending) {
      calendarPending = (async () => {
        const c = contract<OpsCalendar>(
          await (await response("ops-calendar.json")).json(),
          "calendar",
        );
        const dates = new Set<string>();
        c.days.forEach((d, i) => {
          if (
            dates.has(d.date) ||
            !Number.isSafeInteger(d.day_start_ms) ||
            (i > 0 &&
              (d.date <= c.days[i - 1].date ||
                d.day_start_ms <= c.days[i - 1].day_start_ms))
          )
            throw new Error(
              "Ops calendar dates and anchors must be unique and ordered",
            );
          dates.add(d.date);
        });
        return c;
      })().catch((error) => {
        calendarPending = undefined;
        throw error;
      });
    }
    return calendarPending;
  }
  async function template(entry: OpsCalendarDay, timezone: string) {
    const key = entry.scenario;
    if (!files.has(key)) {
      files.set(
        key,
        (async () => {
          const raw = contract<OpsDay>(
            await (await response(`${key}.ops.json`)).json(),
            "day",
          );
          if (raw.meta.scenario !== key)
            throw new Error("Ops scenario mismatch");
          offsets(raw.hours, 0, 24);
          offsets(raw.history.hours, -6 * OPS_HOUR_MS, 6);
          if (raw.meta.floors_file) {
            if (
              !/^[a-zA-Z0-9_.-]+\.json$/.test(raw.meta.floors_file) ||
              !/^[a-f0-9]{64}$/i.test(raw.meta.floors_sha256 ?? "")
            )
              throw new Error(
                "Ops floors reference or SHA-256 missing/invalid",
              );
            const bytes = await (
              await response(raw.meta.floors_file)
            ).arrayBuffer();
            const hash = await crypto.subtle.digest("SHA-256", bytes);
            const hex = Array.from(new Uint8Array(hash), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
            if (hex !== raw.meta.floors_sha256!.toLowerCase())
              throw new Error("Ops floors SHA-256 mismatch");
            const floors = contract<OpsFloorsFile>(
              JSON.parse(new TextDecoder().decode(bytes)),
              "floors",
            );
            if (
              floors.scenario !== key ||
              floors.source_date !== raw.meta.source_date
            )
              throw new Error("Ops floors source mismatch");
            // Join by offsets, independent of sidecar array order. Reject duplicate/missing rows.
            const merge = (rows: OpsHour[], side: OpsFloorsFile["hours"]) => {
              const map = new Map(
                side.map((row) => [row.offset_ms, row.floors]),
              );
              if (map.size !== side.length || map.size !== rows.length)
                throw new Error("Ops floors offsets mismatch");
              return rows.map((row) => {
                const matched = map.get(row.offset_ms);
                if (!matched)
                  throw new Error(`Ops missing floors offset ${row.offset_ms}`);
                return { ...row, floors: matched };
              });
            };
            raw.hours = merge(raw.hours, floors.hours);
            raw.history = {
              ...raw.history,
              hours: merge(raw.history.hours, floors.history),
            };
          }
          if (
            [...raw.hours, ...raw.history.hours].some(
              (h) => h.floors?.length !== raw.meta.floors,
            )
          )
            throw new Error("Ops floors missing");
          raw.elevators.forEach((lift) =>
            lift.trips.forEach((trip, i) => {
              if (
                trip.arrive_ms <= trip.depart_ms ||
                trip.dwell_ms < 0 ||
                (i > 0 &&
                  trip.depart_ms <
                    lift.trips[i - 1].arrive_ms + lift.trips[i - 1].dwell_ms)
              )
                throw new Error(
                  "Ops elevator trips overlap or have invalid duration",
                );
            }),
          );
          return raw;
        })().catch((error) => {
          files.delete(key);
          throw error;
        }),
      );
    }
    const data = await files.get(key)!;
    if (
      data.meta.source_date !== entry.source_date ||
      data.meta.timezone !== timezone
    )
      throw new Error("Ops calendar source/timezone mismatch");
    return { ...structuredClone(data), day_start_ms: entry.day_start_ms };
  }
  async function loadDay(date: string): Promise<OpsDay> {
    const c = await calendarRaw(),
      entry = c.days.find((d) => d.date === date);
    if (!entry) throw new RangeError(`Ops calendar date missing: ${date}`);
    return template(entry, c.timezone);
  }
  async function loadAt(at_ms: number): Promise<OpsDay> {
    if (!Number.isFinite(at_ms))
      throw new RangeError("Ops time must be finite");
    const c = await calendarRaw();
    const entry = c.days.find(
      (d, i) =>
        at_ms >= d.day_start_ms &&
        at_ms <
          Math.min(
            d.day_start_ms + OPS_DAY_MS,
            c.days[i + 1]?.day_start_ms ?? Infinity,
          ),
    );
    if (!entry) throw new RangeError(`Ops calendar time missing: ${at_ms}`);
    return template(entry, c.timezone);
  }
  async function loadWindow(
    start_ms: number,
    end_ms: number,
  ): Promise<OpsWindow> {
    if (
      !Number.isFinite(start_ms) ||
      !Number.isFinite(end_ms) ||
      end_ms <= start_ms ||
      end_ms - start_ms > OPS_DAY_MS
    )
      throw new RangeError(
        "Ops window must be [start,end), positive and at most 24 hours",
      );
    const c = await calendarRaw();
    const entries = c.days.filter(
      (d) => d.day_start_ms < end_ms && d.day_start_ms + OPS_DAY_MS > start_ms,
    );
    let covered = start_ms;
    for (const d of entries) {
      if (d.day_start_ms > covered)
        throw new RangeError("Ops calendar window has missing dates");
      covered = Math.max(covered, d.day_start_ms + OPS_DAY_MS);
    }
    if (!entries.length || covered < end_ms)
      throw new RangeError("Ops calendar window is outside coverage");
    const days = await Promise.all(
      entries.map(async (d) => ({
        date: d.date,
        data: await template(d, c.timezone),
      })),
    );
    const hours = days
      .flatMap(({ date, data }) =>
        data.hours.map((hour) => ({
          date,
          scenario: data.meta.scenario,
          at_ms: data.day_start_ms + hour.offset_ms,
          end_ms: data.day_start_ms + hour.offset_ms + OPS_HOUR_MS,
          hour,
        })),
      )
      .filter((h) => h.at_ms < end_ms && h.end_ms > start_ms);
    return { start_ms, end_ms, days, hours };
  }
  return {
    loadCalendar: async () => structuredClone(await calendarRaw()),
    loadDay,
    loadAt,
    loadWindow,
    clearCache() {
      calendarPending = undefined;
      files.clear();
    },
  };
}
