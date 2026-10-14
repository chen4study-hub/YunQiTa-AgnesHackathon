import type {
  OpsDay,
  OpsHour,
  OpsEnergyTotals,
  OpsWindow,
} from "../../data/ops";
import { opsDateTime, opsTimeLabel } from "./time";
import { formatNumber } from "../../ui/numberFormat";

export const energyNumber = (value: number | null, digits = 0) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return formatNumber(value, Math.max(0, Math.min(1, Math.trunc(digits))));
};
export const END_USES = [
  {
    name: "空调",
    key: "hvac_electric_estimate_kw",
    energyKey: "hvac_electric_estimate_kwh",
    color: "#4fd1d9",
  },
  {
    name: "照明",
    key: "lighting_kw",
    energyKey: "lighting_kwh",
    color: "#e5be6a",
  },
  { name: "插座", key: "plug_kw", energyKey: "plug_kwh", color: "#ad9ae5" },
  {
    name: "电梯",
    key: "elevator_kw",
    energyKey: "elevator_kwh",
    color: "#6b9fff",
  },
  { name: "其他", key: "other_kw", energyKey: "other_kwh", color: "#72cbaa" },
] as const;
/** Read export fields without fixed shares or frontend energy integration. */
export function endUseRows(hour: OpsHour) {
  return END_USES.map((item) => ({ ...item, value: hour.end_uses[item.key] }));
}
export function cumulativeUses(totals: OpsEnergyTotals) {
  return [
    ...END_USES.slice(0, 3).map((item) => ({
      name: item.name,
      energy: totals[item.energyKey],
    })),
    { name: "电梯及其他", energy: totals.elevator_kwh + totals.other_kwh },
  ];
}
export function environmentAt(hour: OpsHour) {
  return hour.environment;
}
export interface EnergyAlert {
  id: string;
  key: string;
  level: string;
  time: string;
  dateTime: string;
  system: string;
  content: string;
  action: string;
  status: string;
  agent: boolean;
  atMs: number;
}
/** Preserve backend IDs/content/status and all supplied records. Never pad to eight. */
export function energyAlerts(day: OpsDay, atMs: number): EnergyAlert[] {
  const map = (
    record: OpsDay["work_orders"][number] | OpsDay["alerts"][number],
    agent: boolean,
    level: string,
  ): EnergyAlert => {
    const eventMs = day.day_start_ms + record.offset_ms;
    return {
      id: record.id,
      key: `${day.day_start_ms}:${agent ? "order" : "alert"}:${record.id}`,
      level,
      time: opsTimeLabel(eventMs, atMs),
      dateTime: opsDateTime(eventMs),
      atMs: eventMs,
      system: record.system,
      content: record.content,
      action: record.suggested_checks.join("；"),
      status: record.status,
      agent,
    };
  };
  return [
    ...day.work_orders
      .filter((r) => day.day_start_ms + r.offset_ms <= atMs)
      .map((r) => map(r, true, "工单")),
    ...day.alerts
      .filter((r) => day.day_start_ms + r.offset_ms <= atMs)
      .map((r) => map(r, false, r.level)),
  ].sort((a, b) => Number(b.agent) - Number(a.agent) || b.atMs - a.atMs);
}
/** Windows contain calendar-bound days; source history is never yesterday's data. */
export function windowAlerts(window: OpsWindow, nowMs: number) {
  return window.days
    .flatMap(({ data }) => energyAlerts(data, Math.min(nowMs, window.end_ms)))
    .filter((row) => row.atMs >= window.start_ms && row.atMs < window.end_ms);
}
