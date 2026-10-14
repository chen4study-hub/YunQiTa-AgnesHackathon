import type { OpsFloor, OpsHour } from "../../data/ops";
// Compatibility for existing page tests; the implementation and cache are public.
export { opsFloorScale } from "../../data/ops";
export const ZONES = [
  "北区",
  "东北区",
  "西区",
  "东区",
  "西南区",
  "南区",
] as const;
export const ZONE_COLORS = [
  "#4fd1d9",
  "#6b9fff",
  "#b7a4ef",
  "#e5be6a",
  "#72cbaa",
  "#ef9b72",
] as const;
const ZONE_LABELS: Record<string, string> = {
  north: "北区",
  northeast: "东北区",
  west: "西区",
  east: "东区",
  southwest: "西南区",
  south: "南区",
};
export function zoneLabel(id: string) {
  return ZONE_LABELS[id] ?? id;
}
export function temperatureColor(value: number) {
  return value < 25.5 ? "#2fbf8f" : value <= 26.5 ? "#e5be6a" : "#f29252";
}
/** The exact exported row, with no occupancy/thermal/lighting formula or fallback. */
export function floorMetrics(hour: OpsHour, floor: number): OpsFloor {
  const row = hour.floors.find((row) => row.floor === floor);
  if (!row) throw new Error(`Ops floor missing: ${floor}`);
  return row;
}
export function floorUseLabel(use: OpsFloor["use"]) {
  return {
    lobby: "首层大堂",
    office: "标准办公层",
    garden: "空中花园",
    equipment: "设备层",
  }[use];
}
