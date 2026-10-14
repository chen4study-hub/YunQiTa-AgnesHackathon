import type { OpsHour } from "../../data/ops";
import { floorMetrics } from "./metrics";
import { floorsNumber } from "./numbers";
/** Lookup only. No solar/load/setpoint-based frontend temperature model. */
export function temperatureAt(hour: OpsHour, floor: number, zoneId: string) {
  const zone = floorMetrics(hour, floor).zones.find(
    (zone) => zone.id === zoneId,
  );
  if (!zone) throw new Error(`Ops zone missing: ${floor}/${zoneId}`);
  return zone.temp_c;
}
/** One 22–28 ℃ display transform for the scale, limit line and value marker. */
export function temperaturePosition(value: number) {
  return Math.max(0, Math.min(100, ((value - 22) / 6) * 100));
}
/** Difference from a displayed reference, not a telemetry-generating formula. */
export function comfortMargin(value: number) {
  const excess = value - 27;
  return {
    exceeded: excess > 0,
    text:
      excess > 0
        ? `超上限 ${floorsNumber(excess, 1)} ℃`
        : `距 27 ℃ 上限 ${floorsNumber(-excess, 1)} ℃`,
  };
}
