import { describe, it, expect, vi } from "vitest";
import {
  createPageOpsResource,
  type PageOpsLoader,
} from "../src/pages/energy/useOpsPage";
import { opsFixtureLoader } from "./ops-page-fixture";

describe("two-page ops resource", () => {
  it("syncs first, caches one calendar day, reloads on midnight and uses public windows", async () => {
    const real = opsFixtureLoader();
    const day = await real.loadDay("2026-10-12");
    const at = day.day_start_ms + 12 * 3600000;
    const calls: string[] = [];
    const loader: PageOpsLoader = {
      ...real,
      loadAt: vi.fn(async (t) => {
        calls.push("load");
        return real.loadAt(t);
      }),
      loadWindow: vi.fn(real.loadWindow),
    };
    const resource = createPageOpsResource(loader, {
      sync: vi.fn(async () => {
        calls.push("sync");
        return { source: "local" as const, offset_ms: 0, timezone: null };
      }),
    });
    await resource.ensure(at);
    await resource.ensure(at + 3600000);
    expect(calls).toEqual(["sync", "load"]);
    await resource.ensure(day.day_start_ms + 86400000);
    expect(calls).toEqual(["sync", "load", "load"]);
    expect(resource.getSnapshot().day!.day_start_ms).toBe(
      day.day_start_ms + 86400000,
    );
    await resource.loadWindow(at, at + 20 * 3600000);
    expect(loader.loadWindow).toHaveBeenCalledWith(at, at + 20 * 3600000);
  });
  it("evicts old display data on failure and only retries explicitly", async () => {
    const real = opsFixtureLoader();
    const day = await real.loadDay("2026-10-12");
    let fail = true;
    const loadAt = vi.fn(async () => {
      if (fail) throw new Error("HTTP 404");
      return day;
    });
    const clearCache = vi.fn();
    const sync = vi.fn(async () => ({
      source: "local" as const,
      offset_ms: 0,
      timezone: null,
    }));
    const resource = createPageOpsResource(
      { ...real, loadAt, clearCache },
      { sync },
    );
    await resource.ensure(day.day_start_ms);
    expect(resource.getSnapshot()).toEqual({
      day: null,
      loading: false,
      error: "HTTP 404",
    });
    await resource.ensure(day.day_start_ms + 3600000);
    expect(loadAt).toHaveBeenCalledTimes(1);
    fail = false;
    await resource.retry(day.day_start_ms);
    expect(clearCache).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(resource.getSnapshot().day).toBe(day);
  });
  it("ignores stale responses and clears yesterday immediately during a date switch", async () => {
    const real = opsFixtureLoader();
    const day = await real.loadDay("2026-10-12");
    const next = await real.loadDay("2026-10-13");
    let resolve: (day: typeof next) => void = () => {};
    const loadAt = vi.fn(async (at) =>
      at === day.day_start_ms
        ? day
        : new Promise<typeof next>((r) => {
            resolve = r;
          }),
    );
    const resource = createPageOpsResource(
      { ...real, loadAt },
      {
        sync: async () => ({
          source: "local" as const,
          offset_ms: 0,
          timezone: null,
        }),
      },
    );
    await resource.ensure(day.day_start_ms);
    const request = resource.ensure(next.day_start_ms);
    await Promise.resolve();
    expect(resource.getSnapshot().day).toBeNull();
    expect(resource.getSnapshot().loading).toBe(true);
    await resource.ensure(day.day_start_ms);
    resolve(next);
    await request;
    expect(resource.getSnapshot().day).toBe(day);
  });
});

it("fails closed for a day outside the store time instead of reusing stale values", async () => {
  const real = opsFixtureLoader();
  const day = await real.loadDay("2026-10-12");
  const resource = createPageOpsResource(
    { ...real, loadAt: async () => day },
    {
      sync: async () => ({
        source: "local" as const,
        offset_ms: 0,
        timezone: null,
      }),
    },
  );
  await resource.ensure(day.day_start_ms + 86400000);
  expect(resource.getSnapshot().day).toBeNull();
  expect(resource.getSnapshot().error).toContain("does not cover display time");
});
