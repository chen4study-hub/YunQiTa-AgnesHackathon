import type { ReplayData } from "../src/data/types";
import { replayDecision } from "../src/pages/agent/data";
export function scheduleFixture(
  data: ReplayData,
  index: number,
  record: any = null,
) {
  const d = replayDecision(data, index),
    manual = record && (record.record_status ?? record.status) === "active";
  const battery = manual
    ? record.storage_mode === "charge"
      ? -record.storage_power_kw
      : record.storage_mode === "idle"
        ? 0
        : record.storage_power_kw
    : d.battery;
  return {
    building_id: data.meta.building_id,
    status: manual ? "manual" : d.handoff ? "handoff" : "executed",
    source: manual ? "manual" : data.hours[index].agent.source,
    active_takeover: manual ? record : null,
    selected: d.selected,
    reason: manual ? record.reason : d.reason,
    plan: [
      {
        timestamp: d.t,
        hvac_setpoint_c: manual ? record.hvac_setpoint_c : d.temp,
        battery_kw: battery,
        action: manual ? "manual" : d.handoff ? "human_review" : "hold",
      },
    ],
    candidates: d.candidates.map((c) => ({
      candidate_id: c.id,
      passed: c.passed,
      plan: [
        { timestamp: d.t, hvac_setpoint_c: c.temp, battery_kw: c.battery },
      ],
      simulation: { estimated_cost: c.cost, estimated_peak_kw: c.peak },
    })),
    work_orders: [],
    receipt: { count: 0 },
  };
}
