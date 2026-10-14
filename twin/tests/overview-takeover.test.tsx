import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactNode } from "react";
// Keep behavioral text assertions independent of atomic status-word wrappers.
const renderToStaticMarkup = (node: ReactNode) =>
  renderMarkup(node).replace(
    /<i class="overview-status-word">([^<]*)<\/i>/g,
    "$1",
  );
import {
  loadActiveTakeover,
  pollActiveTakeover,
} from "../src/data/activeTakeover";
import { OverviewTakeover } from "../src/components/OverviewTakeover";
import { OverviewVerdict } from "../src/components/OverviewVerdict";
import { mockReplay } from "../src/data/adapters";
import type { LiveSchedule } from "../src/data/liveSchedule";
import { formatLocalMinute } from "../src/config/displayTime";

const feed = vi.hoisted(() => ({ record: null as Takeover | null }));
vi.mock("../src/data/useActiveTakeover", () => ({
  useActiveTakeover: () => feed.record,
}));
import type { Takeover } from "../src/pages/agent/takeover-api";
const start = Date.parse("2026-10-12T14:00:00+08:00");
const record: Takeover = {
  id: "t1",
  version: 1,
  date: "2026-10-12",
  hour: 14,
  start_at: "",
  end_at: "",
  start_ms: start,
  end_ms: start + 7200000,
  hvac_setpoint_c: 26,
  storage_mode: "charge",
  storage_power_kw: 55,
  operator_id: "陈工",
  reason: "人工巡检",
  status: "active",
  record_status: "active",
};
afterEach(() => {
  feed.record = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("read-only active takeover", () => {
  it("requires valid JSON with api_version and hour coverage", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ api_version: "1", takeover: record }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await loadActiveTakeover("2026-10-12", 14, new AbortController().signal),
    ).toEqual(record);
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/takeover/active?date=2026-10-12&hour=14",
    );
    expect(
      await loadActiveTakeover("2026-10-12", 17, new AbortController().signal),
    ).toBeNull();
  });
  it.each(["active", "cancelled", "expired", undefined])(
    "respects record_status %s for a cancellation within the viewed hour",
    async (record_status) => {
      const takeover = {
        ...record,
        record_status,
        ...(record_status === "cancelled"
          ? { cancelled_ms: start + 1800000 }
          : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ api_version: "1", takeover }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const result = await loadActiveTakeover(
        "2026-10-12",
        14,
        new AbortController().signal,
      );
      if (record_status === "active" || record_status === "cancelled")
        expect(result).toEqual(takeover);
      else expect(result).toBeNull();
    },
  );
  it("cancelled has no countdown and expired has no status display", () => {
    const cancelled = renderToStaticMarkup(
      <OverviewTakeover
        record={{
          ...record,
          record_status: "cancelled",
          cancelled_ms: start + 1800000,
        }}
        nowMs={start + 1800000}
      />,
    );
    expect(cancelled).toContain(
      `本小时人工接管已撤销 · 撤销时间 ${formatLocalMinute(start + 1800000)} · 操作人 陈工`,
    );
    expect(cancelled).not.toMatch(/人工接管中|剩余|人工设定温度|储能/);
    expect(
      renderToStaticMarkup(
        <OverviewTakeover
          record={{ ...record, record_status: "expired" }}
          nowMs={start}
        />,
      ),
    ).toBe("");
  });
  it("cancelled restores the exported decision and reason, active alone replaces it, expired has no notice", () => {
    const hour = mockReplay("normal").hours[14];
    hour.agent.explanation = "已恢复的导出决策理由";
    hour.agent.actions = ["BA设定温度 25.8 °C", "EMS储能功率 0.0 kW"];
    hour.agent.status = "executed";
    const staleSchedule: LiveSchedule = {
      t: hour.t,
      handoff: false,
      upper: 1200,
      confidence: 0.9,
      threshold: 0.8,
      temp: 26,
      battery: 55,
      reason: "旧人工调度缓存不可展示",
      candidates: [],
      selected: "cached",
      source: "schedule",
      receipt: {
        count: 1,
        elapsed: null,
        transport: "log",
        connected: false,
        known: true,
      },
      ticket: { id: "", reasons: [], checks: [], temp: null, battery: null },
      grounding: true,
    };
    const render = () =>
      renderToStaticMarkup(
        <OverviewVerdict
          scenario="normal"
          hour={hour}
          time={14}
          nowMs={start}
          liveDecision={staleSchedule}
        />,
      );
    feed.record = {
      ...record,
      record_status: "cancelled",
      cancelled_ms: start + 1800000,
    };
    const html = render();
    expect(html).toContain("已恢复的导出决策理由");
    expect(html).not.toContain("旧人工调度缓存不可展示");
    expect(html).toContain('data-decision-source="replay"');
    expect(html).toContain("BA 设定温度 25.8 °C");
    expect(html).toContain("EMS 储能功率 0.0 kW");
    expect(html).toContain("本小时人工接管已撤销");
    expect(html).not.toMatch(/aria-hidden="true"|人工设定温度|充电 55.0|剩余/);
    feed.record = record;
    const active = render();
    expect(active).toContain('aria-hidden="true"');
    expect(active).toContain("人工设定温度 26.0 °C");
    feed.record = { ...record, record_status: "expired" };
    expect(render()).not.toMatch(/接管已撤销|人工设定温度|aria-hidden="true"/);
  });
  it.each([
    [200, "text/html", "<!doctype html>"],
    [
      404,
      "application/json",
      JSON.stringify({ api_version: "1", takeover: record }),
    ],
    [200, "application/json", JSON.stringify({ takeover: record })],
    [
      200,
      "application/json",
      JSON.stringify({ api_version: "1", takeover: null }),
    ],
    [200, "application/json", "{"],
    [
      200,
      "application/json",
      JSON.stringify({ api_version: "1", takeover: { id: "invalid" } }),
    ],
  ])(
    "silently ignores unavailable/null/malformed response %#",
    async (status, type, body) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { status, headers: { "content-type": type } }),
          ),
      );
      expect(
        await loadActiveTakeover(
          "2026-10-12",
          14,
          new AbortController().signal,
        ),
      ).toBeNull();
    },
  );
  it("times out silently", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new Error("abort")),
            ),
          ),
      ),
    );
    const result = loadActiveTakeover(
      "2026-10-12",
      14,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toBeNull();
  });
  it("polls every 3s, pauses hidden, refreshes on visibility/focus and aborts stale responses", async () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), {
        visibilityState: "visible",
      }),
      win = new EventTarget();
    const load = vi.fn().mockResolvedValue(record),
      publish = vi.fn();
    const stop = pollActiveTakeover(
      "2026-10-12",
      14,
      publish,
      { document: doc, window: win },
      load,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(9000);
    win.dispatchEvent(new Event("focus"));
    expect(load).toHaveBeenCalledTimes(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(load).toHaveBeenCalledTimes(4);
    let resolve!: (value: Takeover | null) => void;
    const pending = vi.fn(
      () =>
        new Promise<Takeover | null>((r) => {
          resolve = r;
        }),
    );
    const stalePublish = vi.fn();
    const cancel = pollActiveTakeover(
      "2026-10-12",
      14,
      stalePublish,
      { document: doc, window: win },
      pending,
    );
    cancel();
    resolve(record);
    await vi.advanceTimersByTimeAsync(0);
    expect(stalePublish).not.toHaveBeenCalled();
  });
  it("shows only human settings, rounded-up remaining hours and no controls", () => {
    const html = renderToStaticMarkup(
      <OverviewTakeover record={record} nowMs={start + 1800000} />,
    );
    expect(html).toContain("人工接管中 · 操作人 陈工 · 剩余 2 小时");
    expect(html).toContain("人工设定温度 26.0 °C");
    expect(html).toContain("储能 充电 55.0 kW");
    expect(html).not.toMatch(/button|结论被覆盖/);
    const idle = renderToStaticMarkup(
      <OverviewTakeover
        record={{ ...record, storage_mode: "idle" }}
        nowMs={record.end_ms}
      />,
    );
    expect(idle).toContain("剩余 0 小时");
    expect(idle).toContain("储能 待机");
    expect(idle).not.toContain("kW");
    expect(
      renderToStaticMarkup(
        <OverviewTakeover
          record={{ ...record, storage_mode: "discharge" }}
          nowMs={start}
        />,
      ),
    ).toContain("放电 55.0 kW");
  });
});
