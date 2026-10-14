import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubRaf } from "./raf-test-helper";
beforeEach(stubRaf);
afterEach(() => vi.unstubAllGlobals());
import { readFileSync } from "node:fs";
import { DashboardStore } from "../src/state/store";
import {
  MockAdapter,
  ReplayFileAdapter,
  mockReplay,
} from "../src/data/adapters";
import { createSource, withFallback } from "../src/data/source";
import { validateReplay } from "../src/data/types";
import { ScaleViewport } from "../src/components/ScaleViewport";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

describe("contracts 1.2–1.5 and synchronized files", () => {
  it("matches the root snapshot without skipping migration", () => {
    const local = JSON.parse(
      readFileSync("src/data/contracts/replay.schema.json", "utf8"),
    );
    const root = JSON.parse(
      readFileSync("../contracts/replay.schema.json", "utf8"),
    );
    expect(local).toEqual(root);
  });
  for (const scenario of ["normal", "peak", "abstain"]) {
    it(`validates exported ${scenario} and deterministic realistic fixtures`, () => {
      expect(
        validateReplay(
          JSON.parse(readFileSync(`public/replay/${scenario}.json`, "utf8")),
        ).schema_version,
      ).toBe("1.5");
      const data = mockReplay(scenario);
      expect(data).toEqual(mockReplay(scenario));
      data.hours.forEach((hour) => {
        expect(hour.point_kw).toBeGreaterThanOrEqual(800);
        expect(hour.point_kw).toBeLessThanOrEqual(1300);
      });
    });
  }
  it("rejects old contracts, extra fields and out-of-range SOC", () => {
    const data = mockReplay("normal");
    expect(() => validateReplay({ ...data, schema_version: "1.0" })).toThrow();
    expect(() => validateReplay({ ...data, schema_version: "1.1" })).toThrow();
    expect(validateReplay(data).schema_version).toBe("1.2");
    expect(() => validateReplay({ ...data, extra: true })).toThrow();
    data.hours[0].storage.soc = 0.96;
    expect(() => validateReplay(data)).toThrow();
  });
  it("missing files/API/model cards fail closed; only explicit mock uses fixtures", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    for (const query of ["", "?source=file", "?source=api"]) {
      const source = createSource(query);
      expect(withFallback(source)).toBe(source);
      await expect(source.loadScenario("normal")).rejects.toThrow("404");
      await expect(source.listScenarios()).rejects.toThrow("404");
      await expect(source.loadModelCard()).rejects.toThrow("404");
    }
    fetcher.mockClear();
    const source = createSource("?source=mock");
    expect((await source.loadScenario("normal")).meta.model_version).toBe(
      "mock-contract-1.2",
    );
    expect(await source.listScenarios()).toHaveLength(3);
    expect((await source.loadModelCard()).cross_building_coverage).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("defaults to file URL", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(mockReplay("normal")),
    );
    const fetcher = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    }));
    vi.stubGlobal("fetch", fetcher);
    await createSource("").loadScenario("normal");
    expect(fetcher).toHaveBeenCalledWith("/replay/normal.json");
    vi.unstubAllGlobals();
  });
});

describe("subscribable global state", () => {
  it("retains scenario, hour, floor and switches when changing pages", async () => {
    const store = new DashboardStore(new MockAdapter());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.initialize();
    await store.loadScenario("peak");
    store.setHour(10);
    store.selectFloor(22);
    store.setSwitch("xray", true);
    store.setPage("agent");
    expect(store.getSnapshot()).toMatchObject({
      page: "agent",
      scenario: "peak",
      hour: 10,
      selectedFloor: 22,
      switches: { xray: true },
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    store.dispose();
  });
  it("plays continuously from now through a 24h budget and preserves paused cursor", () => {
    vi.useFakeTimers();
    const store = new DashboardStore(new MockAdapter(), undefined, {
      query: "?at=2026-10-12T14:00",
    });
    store.setHour(14);
    store.togglePlayback();
    vi.advanceTimersByTime(1000);
    expect(store.getSnapshot().hour).toBe(14);
    // Frame reads use the shared wall epoch, not the last RAF (992ms).
    expect(store.getPlaybackFrame().time).toBe(15);
    store.pause();
    const paused = store.getSnapshot().time;
    vi.advanceTimersByTime(3000);
    expect(store.getSnapshot().time).toBe(paused);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it("ignores stale scenario responses", async () => {
    let resolve!: (value: ReturnType<typeof mockReplay>) => void;
    const source = new MockAdapter();
    source.loadScenario = vi.fn((id: string) =>
      id === "normal"
        ? new Promise<ReturnType<typeof mockReplay>>((done) => {
            resolve = done;
          })
        : Promise.resolve(mockReplay(id)),
    );
    const store = new DashboardStore(withFallback(source));
    const old = store.loadScenario("normal");
    await store.loadScenario("peak");
    resolve(mockReplay("normal"));
    await old;
    expect(store.getSnapshot().data?.meta.scenario).toBe("peak");
    store.dispose();
  });
  it("renders intrinsic viewport without transforms or fixed stage", () => {
    const html = renderToStaticMarkup(
      createElement(ScaleViewport, null, "content"),
    );
    expect(html).toContain("content");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("1920");
  });
});
