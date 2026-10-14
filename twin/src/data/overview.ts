import type { ReplayData, Hour } from "./types";
import type { OpsMeta } from "./ops/model";
import { formatNumber as displayNumber } from "../ui/numberFormat";
// Compatibility: overview's existing callers request integer defaults.
export const formatNumber = (value: number, digits = 0) =>
  displayNumber(value, digits);
/** The exported hourly price schedule is the sole authority; no local price fallback. */
export function tariff(
  hour: number,
  schedule: OpsMeta["tariff"] | null,
): number | null {
  const price = schedule?.prices[hour];
  return Number.isInteger(hour) &&
    hour >= 0 &&
    hour < 24 &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price >= 0
    ? price
    : null;
}
export function peakTariff(schedule: OpsMeta["tariff"] | null): number | null {
  if (!schedule) return null;
  const prices = schedule.prices.filter(
    (_, i) => schedule.periods[i] === "peak",
  );
  return prices.length ? Math.max(...prices) : null;
}
export function cumulativeEnergy(data: ReplayData, time: number) {
  let energy = 0;
  for (let i = 0; i < Math.min(time, 23); i++) {
    const width = Math.min(1, time - i);
    const a = data.hours[i].actual_kw,
      b = data.hours[Math.min(23, i + 1)].actual_kw;
    energy += (width * (a + (a + (b - a) * width))) / 2;
  }
  return energy;
}
export function daySummary(
  data: ReplayData,
  schedule: OpsMeta["tariff"] | null = null,
) {
  const peak = data.hours.reduce(
    (best, hour, i) => (hour.point_kw > data.hours[best].point_kw ? i : best),
    0,
  );
  return {
    peak: data.hours[peak].point_kw,
    peakHour: peak,
    rejected: data.hours.filter((h) => h.abstain).length,
    executed: data.hours.filter((h) => h.agent.status === "executed").length,
    handoff: data.hours.filter((h) => h.agent.status === "handoff").length,
    estimatedCost: data.hours.every((_, i) => tariff(i, schedule) !== null)
      ? data.hours.reduce(
          (sum, h, i) => sum + h.point_kw * tariff(i, schedule)!,
          0,
        )
      : null,
  };
}
export function agentVerdict(hour: Hour, displayDate: string, index: number) {
  const agent = hour.agent;
  const handoff = agent.status === "handoff";
  const order = agent.work_orders?.[0];
  const rawId = order?.id ?? order?.work_order_id ?? order?.order_id;
  return {
    handoff,
    explanation: agent.explanation,
    actions: agent.actions.slice(0, 2),
    reason: hour.abstain_reason ?? agent.explanation,
    order:
      rawId == null
        ? `#${displayDate.replaceAll("-", "").slice(0, 4)}-${displayDate.replaceAll("-", "").slice(4)}-${String(index + 1).padStart(2, "0")}`
        : `#${String(rawId).replace(/^#/, "")}`,
    orderGenerated: rawId == null,
    receiptNormal: Number(agent.receipt?.count ?? 0) > 0,
    simulated: agent.receipt?.device_connected !== true,
  };
}
