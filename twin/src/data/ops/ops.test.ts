import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  createOpsLoader,
  createOpsClock,
  evaluateElevator,
  evaluateOpsSnapshot,
  OPS_DAY_MS,
  OPS_HOUR_MS,
  type OpsDay,
  type OpsCalendar,
  type OpsFloorsFile,
  type OpsElevator,
  type OpsFetch,
} from "./index";
const root = new URL("../../../../exports/replay/", import.meta.url);
const bytes = (name: string) => readFile(new URL(name, root));
async function json<T>(name: string): Promise<T> {
  return JSON.parse((await bytes(name)).toString("utf8"));
}
function fileFetch(overrides: Record<string, string> = {}) {
  return vi.fn<OpsFetch>(async (url) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    return new Response(overrides[name] ?? (await bytes(name)), {
      headers: { "Content-Type": "application/json" },
    });
  });
}
async function example(scenario: string) {
  const calendar = await json<OpsCalendar>("ops-calendar.json");
  return calendar.days.find((d) => d.scenario === scenario)!;
}

describe("loader using repository root exports", () => {
  it.each(["normal", "peak", "abstain"])(
    "binds %s and joins all floor rows without altering business fields",
    async (scenario) => {
      const entry = await example(scenario),
        request = fileFetch(),
        loader = createOpsLoader({ fetch: request });
      const day = await loader.loadDay(entry.date),
        raw = await json<OpsDay>(`${scenario}.ops.json`);
      expect(day.day_start_ms).toBe(entry.day_start_ms);
      expect(raw.day_start_ms).toBe(0);
      expect(day.meta).toEqual(raw.meta);
      expect(day.elevators).toEqual(raw.elevators);
      const side = raw.meta.floors_file
        ? await json<OpsFloorsFile>(raw.meta.floors_file)
        : undefined;
      for (const [rows, original, sideRows] of [
        [day.hours, raw.hours, side?.hours],
        [day.history.hours, raw.history.hours, side?.history],
      ] as const) {
        rows.forEach((row, i) => {
          expect(row.floors).toHaveLength(40);
          expect(row.floors).toEqual(
            sideRows?.find((r) => r.offset_ms === row.offset_ms)?.floors ??
              original[i].floors,
          );
          const { floors: _, ...rest } = row,
            { floors: __, ...source } = original[i];
          expect(rest).toEqual(source);
        });
      }
      expect(request.mock.calls.map(([url]) => url)).toEqual([
        "/replay/ops-calendar.json",
        `/replay/${scenario}.ops.json`,
        ...(raw.meta.floors_file ? [`/replay/${raw.meta.floors_file}`] : []),
      ]);
    },
  );
  it("shares concurrent reads, isolates consumers and retries failed loads", async () => {
    const entry = await example("normal"),
      request = fileFetch(),
      loader = createOpsLoader({ fetch: request });
    const [a, b] = await Promise.all([
      loader.loadDay(entry.date),
      loader.loadDay(entry.date),
    ]);
    a.hours[0].floors[0].floor_kw = -1;
    a.meta.zones[0] = "changed";
    expect(b.hours[0].floors[0].floor_kw).toBeGreaterThan(0);
    expect(b.meta.zones[0]).toBe("north");
    expect(request).toHaveBeenCalledTimes(3);
    request.mockRejectedValueOnce(new Error("offline"));
    loader.clearCache();
    await expect(loader.loadDay(entry.date)).rejects.toThrow("offline");
    expect((await loader.loadDay(entry.date)).hours[0].floors).toHaveLength(40);
  });
  it("rejects bad SHA before merging, and will not silently use stale inline rows", async () => {
    const entry = await example("normal"),
      raw = await json<OpsDay>("normal.ops.json");
    const name = raw.meta.floors_file!,
      request = fileFetch({ [name]: (await bytes(name)).toString() + " " });
    const loader = createOpsLoader({ fetch: request });
    await expect(loader.loadDay(entry.date)).rejects.toThrow(
      "SHA-256 mismatch",
    );
    request.mockImplementation(fileFetch());
    expect((await loader.loadDay(entry.date)).hours[0].floors).toHaveLength(40);
  });
  it("joins reordered sidecars by offset and rejects duplicate offsets/source mismatch", async () => {
    const entry = await example("peak"),
      raw = await json<OpsDay>("peak.ops.json");
    const side = await json<OpsFloorsFile>(raw.meta.floors_file!);
    side.hours.reverse();
    side.history.reverse();
    const load = () => {
      const text = JSON.stringify(side);
      raw.meta.floors_sha256 = createHash("sha256").update(text).digest("hex");
      return createOpsLoader({
        fetch: fileFetch({
          "peak.ops.json": JSON.stringify(raw),
          [raw.meta.floors_file!]: text,
        }),
      }).loadDay(entry.date);
    };
    expect((await load()).hours[0].floors).toEqual(side.hours.at(-1)!.floors);
    side.hours[0].offset_ms = side.hours[1].offset_ms;
    await expect(load()).rejects.toThrow("offsets mismatch");
    side.source_date = "2000-01-01";
    await expect(load()).rejects.toThrow("source mismatch");
  });
  it("splices adjacent calendar dates across midnight, never source history or modulo", async () => {
    const c = await json<OpsCalendar>("ops-calendar.json");
    const i = c.days.findIndex(
      (d, i) => i > 0 && d.scenario !== c.days[i - 1].scenario,
    );
    const before = c.days[i - 1],
      after = c.days[i],
      loader = createOpsLoader({ fetch: fileFetch() });
    const window = await loader.loadWindow(
      after.day_start_ms - 2 * OPS_HOUR_MS,
      after.day_start_ms + OPS_HOUR_MS,
    );
    expect(window.days.map((d) => d.date)).toEqual([before.date, after.date]);
    expect(window.hours.map((h) => h.at_ms)).toEqual([
      after.day_start_ms - 2 * OPS_HOUR_MS,
      after.day_start_ms - OPS_HOUR_MS,
      after.day_start_ms,
    ]);
    expect(window.hours.map((h) => h.hour.offset_ms)).toEqual([
      22 * OPS_HOUR_MS,
      23 * OPS_HOUR_MS,
      0,
    ]);
    expect(window.hours.map((h) => h.scenario)).toEqual([
      before.scenario,
      before.scenario,
      after.scenario,
    ]);
    expect((await loader.loadAt(after.day_start_ms)).meta.scenario).toBe(
      after.scenario,
    );
    expect((await loader.loadAt(after.day_start_ms - 1)).meta.scenario).toBe(
      before.scenario,
    );
    expect(
      evaluateOpsSnapshot(
        await loader.loadAt(after.day_start_ms),
        after.day_start_ms,
      ).hour.offset_ms,
    ).toBe(0);
    const one = await loader.loadWindow(
      after.day_start_ms - OPS_HOUR_MS,
      after.day_start_ms,
    );
    expect(one.days.map((d) => d.date)).toEqual([before.date]);
    await expect(
      loader.loadWindow(c.days[0].day_start_ms - 1, c.days[0].day_start_ms + 1),
    ).rejects.toThrow(RangeError);
    await expect(
      loader.loadAt(c.days.at(-1)!.day_start_ms + OPS_DAY_MS),
    ).rejects.toThrow("missing");
    await expect(loader.loadDay("2000-01-01")).rejects.toThrow("missing");
    await expect(loader.loadWindow(2, 1)).rejects.toThrow("window");
    await expect(loader.loadWindow(0, OPS_DAY_MS + 1)).rejects.toThrow(
      "window",
    );
  });
});
describe("continuous elevator evaluation", () => {
  it.each(["normal", "peak", "abstain"])(
    "evaluates exported %s routes at every boundary",
    async (scenario) => {
      const entry = await example(scenario),
        day = await createOpsLoader({ fetch: fileFetch() }).loadDay(entry.date);
      for (const lift of day.elevators) {
        const at = (offset: number) =>
          evaluateElevator(
            lift,
            day.meta,
            day.day_start_ms,
            day.day_start_ms + offset,
          );
        expect(at(lift.trips[0].depart_ms - 1)).toMatchObject({
          floor: lift.initial_floor,
          status: "idle",
        });
        for (const trip of lift.trips) {
          expect(at(trip.depart_ms)).toMatchObject({
            floor: trip.from_floor,
            status: trip.to_floor > trip.from_floor ? "up" : "down",
            load_pct: trip.load_pct,
          });
          expect(at((trip.depart_ms + trip.arrive_ms) / 2).floor).toBeCloseTo(
            (trip.from_floor + trip.to_floor) / 2,
            10,
          );
          expect(at(trip.arrive_ms)).toMatchObject({
            floor: trip.to_floor,
            status: "doors",
            direction: 0,
          });
          expect(at(trip.arrive_ms + trip.dwell_ms - 1).status).toBe("doors");
          expect(at(trip.arrive_ms + trip.dwell_ms).status).not.toBe("doors");
          const last = at(trip.arrive_ms - 0.001);
          expect(last.floor).toBeCloseTo(trip.to_floor, 8);
          const near = at(trip.depart_ms + 0.001);
          expect(near.floor).toBeCloseTo(trip.from_floor, 8);
        }
        expect(at(OPS_DAY_MS - 1).status).toBe("idle");
      }
      expect(() =>
        evaluateOpsSnapshot(day, day.day_start_ms + OPS_DAY_MS),
      ).toThrow("outside");
    },
  );
  it("uses meta for triangular short runs and trapezoidal long runs, not linear progress", async () => {
    const raw = await json<OpsDay>("normal.ops.json"),
      base = raw.elevators[0];
    for (const to of [2, 40]) {
      const meta = {
        ...raw.meta,
        floor_height_m: 4,
        max_speed_m_s: 4,
        acceleration_m_s2: 2,
      };
      const d = (to - 1) * meta.floor_height_m,
        t = Math.min(4 / 2, Math.sqrt(d / 2));
      const cruise = Math.max(0, (d - 2 * t * t) / 4),
        duration = 2 * t + cruise,
        ms = Math.ceil(duration * 1000);
      const lift: OpsElevator = {
        ...base,
        trips: [
          {
            depart_ms: 100,
            arrive_ms: 100 + ms,
            from_floor: 1,
            to_floor: to,
            dwell_ms: 30,
            load_pct: 50,
            passengers: 10,
          },
        ],
      };
      const accelerationSample = t / 2 / duration;
      const state = evaluateElevator(
        lift,
        meta,
        1000,
        1000 + 100 + ms * accelerationSample,
      );
      expect(state.floor).toBeCloseTo(1 + (0.5 * 2 * (t / 2) ** 2) / 4, 10);
      expect(state.floor).not.toBeCloseTo(1 + (to - 1) * accelerationSample, 3);
      expect(
        evaluateElevator(lift, meta, 1000, 1000 + 100 + ms + 30),
      ).toMatchObject({ floor: to, status: "idle", load_pct: 0 });
    }
  });
});

describe("ops clock", () => {
  it("calls the backend once per concurrent sync and applies midpoint plus monotonic elapsed", async () => {
    let wall = 1000,
      monotonic = 100;
    const request = vi.fn<OpsFetch>(async () => {
      monotonic = 300;
      wall = 1200;
      return Response.json({
        schema_version: "1.0",
        epoch_ms: 5000,
        timezone: "Asia/Shanghai",
      });
    });
    const clock = createOpsClock({
      fetch: request,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
    });
    expect(clock.now()).toBe(1000);
    const [a, b] = await Promise.all([clock.sync(), clock.sync()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      source: "backend",
      offset_ms: 3900,
      timezone: "Asia/Shanghai",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/api/ops/time",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    monotonic += 500;
    wall = -999;
    expect(clock.now()).toBe(5600);
    request.mockRejectedValueOnce(new Error("offline"));
    expect((await clock.sync()).source).toBe("local");
    expect(clock.now()).toBe(-999);
  });
  it.each(["404", "html", "invalid"])(
    "falls back on %s without fabricating server time",
    async (kind) => {
      const request: OpsFetch = async () =>
        kind === "404"
          ? new Response("", { status: 404 })
          : kind === "html"
            ? new Response("<html>")
            : Response.json({ epoch_ms: 1 });
      const clock = createOpsClock({ fetch: request, wallNow: () => 1234 });
      expect(await clock.sync()).toMatchObject({
        source: "local",
        offset_ms: 0,
        error: expect.any(String),
      });
      expect(clock.now()).toBe(1234);
    },
  );
  it("aborts timed out requests and releases its timer", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const clock = createOpsClock({
        timeoutMs: 50,
        wallNow: () => 42,
        fetch: async (_, init) => {
          signal = init?.signal as AbortSignal;
          return new Promise(() => {});
        },
      });
      const sync = clock.sync();
      await vi.advanceTimersByTimeAsync(51);
      expect(await sync).toMatchObject({
        source: "local",
        error: "Ops time timeout",
      });
      expect(signal?.aborted).toBe(true);
      expect(clock.now()).toBe(42);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
