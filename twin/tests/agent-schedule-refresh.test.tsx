import { it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSchedule, invalidateSchedule } from "../src/pages/agent/api";
import { scheduleDecision, replayDecision } from "../src/pages/agent/data";
import { RecordTable } from "../src/pages/agent/RecordTable";
import { scheduleFixture } from "../e2e/agent-schedule-fixture";
const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
afterEach(() => vi.unstubAllGlobals());
it("create/cancel invalidation evicts exactly this display-hour promise and next schedule restores executed", async () => {
  const record = {
    status: "active",
    operator_id: "人工甲",
    hvac_setpoint_c: 26,
    storage_mode: "charge",
    storage_power_kw: 120,
    reason: "人工配置",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => scheduleFixture(data, 3, record),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => scheduleFixture(data, 3),
    });
  vi.stubGlobal("fetch", fetcher);
  const old = await loadSchedule(data, 3, "normal", "2026-10-13");
  expect(old?.lifecycle).toBe("manual");
  expect(old?.battery).toBe(-120);
  expect(old?.manualOperator).toBe("人工甲");
  expect(await loadSchedule(data, 3, "normal", "2026-10-13")).toBe(old);
  expect(fetcher).toHaveBeenCalledTimes(1);
  invalidateSchedule(data, 3, "normal", "2026-10-13");
  const restored = await loadSchedule(data, 3, "normal", "2026-10-13");
  expect(restored?.lifecycle).toBe("executed");
  expect(restored?.handoff).toBe(false);
  expect(restored?.manualOperator).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("schedule lifecycle is authoritative, manual is not forecast refusal, cancellation produces no work-order row", () => {
  const record = {
    status: "active",
    operator_id: "人工甲",
    hvac_setpoint_c: 26,
    storage_mode: "charge",
    storage_power_kw: 120,
    reason: "人工配置",
  };
  for (const [input, label] of [
    [scheduleFixture(data, 3, record), "人工接管 · 操作人 人工甲"],
    [
      {
        ...scheduleFixture(data, 3),
        status: "handoff",
        plan: [
          { timestamp: data.hours[3].t, hvac_setpoint_c: 25.5, battery_kw: 0 },
        ],
      },
      "预测拒绝",
    ],
  ] as const) {
    const d = scheduleDecision(input, data, 3)!;
    expect(d).not.toBeNull();
    const html = renderToStaticMarkup(
      <RecordTable data={data} index={3} current={d} statuses={{}} connected />,
    );
    expect(html).toContain(label);
    expect(html).not.toContain("人工工单");
  }
  const refused = structuredClone(data);
  refused.hours[3].abstain = true;
  refused.hours[3].agent.status = "handoff";
  const executed = scheduleDecision(
    { ...scheduleFixture(data, 3), status: "executed" },
    refused,
    3,
  )!;
  expect(executed.handoff).toBe(false);
  expect(executed.lifecycle).toBe("executed");
  const html = renderToStaticMarkup(
    <RecordTable
      data={data}
      index={3}
      current={executed}
      statuses={{}}
      connected
    />,
  );
  expect(html).not.toContain("人工工单");
  expect(html).not.toContain("人工接管");
  expect(html).not.toContain("预测拒绝");
});
