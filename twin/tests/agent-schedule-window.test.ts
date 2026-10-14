import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import { scheduleDecision } from "../src/pages/agent/data";

it("future work orders do not reject a valid current-hour rolling dispatch", () => {
  const data = JSON.parse(
    readFileSync("public/replay/peak.json", "utf8"),
  ) as ReplayData;
  const h = data.hours[14];
  const command = {
    timestamp: h.t,
    hvac_setpoint_c: 25.5,
    battery_kw: 1.6,
    action: "dispatch",
  };
  const response = {
    building_id: data.meta.building_id,
    plan: [command],
    candidates: [
      {
        candidate_id: "rule_conservative",
        plan: [command],
        simulation: { estimated_cost: 16554.8, estimated_peak_kw: 1143.1 },
      },
    ],
    selected: "rule_conservative",
    reason: "当前小时通过；未来拒绝小时保持设定。",
    needs_human: false,
    work_orders: [{ timestamp: "2017-07-21T11:00:00-05:00" }],
    receipt: {
      count: 2,
      elapsed_ms: 0.768,
      transport: "log_only",
      device_connected: false,
    },
  };
  const d = scheduleDecision(response, data, 14)!;
  expect(d.source).toBe("schedule");
  expect(d.handoff).toBe(false);
  expect(d.receipt.count).toBe(2);
  expect(d.candidates).toHaveLength(1);
  for (const work_orders of [
    [{ timestamp: h.t }],
    [{}],
    [{ timestamp: "invalid" }],
  ]) {
    expect(scheduleDecision({ ...response, work_orders }, data, 14)).toBeNull();
    const hold = { ...command, battery_kw: 0, action: "hold" };
    const held = scheduleDecision(
      { ...response, work_orders, plan: [hold] },
      data,
      14,
    )!;
    expect(held.handoff).toBe(true);
    expect(held.receipt.count).toBe(response.receipt.count); // Do not rewrite authoritative numbers.
  }
  expect(
    scheduleDecision({ ...response, needs_human: true }, data, 14),
  ).toBeNull();
});
