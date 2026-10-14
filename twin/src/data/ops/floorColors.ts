import { floorScale, type FloorColorScale } from "../../ui/floorColors";
import { OPS_HOUR_MS, type OpsDay } from "./model";

const scales = new WeakMap<OpsDay, FloorColorScale>();
/** Fixed daily reference: actual office loads at 08:00–20:00 inclusive.
 * Shared with the floor page; does not follow the playback time. */
export function opsFloorScale(day: OpsDay): FloorColorScale {
  let scale = scales.get(day);
  if (!scale) {
    scale = Object.freeze(
      floorScale(
        day.hours
          .slice(8, 21)
          .flatMap((hour) =>
            hour.floors
              .filter((floor) => floor.use === "office")
              .map((floor) => floor.floor_actual_kw),
          ),
      ),
    );
    scales.set(day, scale);
  }
  return scale;
}
/** Actual floor loads at the continuous playhead, keyed by 1-based floor number.
 * Linear between exported hours; hold the final hour, never wrap to this day's 00:00. */
export function sampleOpsFloorLoads(
  day: OpsDay,
  at_ms: number,
): readonly number[] {
  const position = Math.max(
    0,
    Math.min(day.hours.length - 1, (at_ms - day.day_start_ms) / OPS_HOUR_MS),
  );
  const index = Math.floor(position),
    fraction = position - index;
  const from = day.hours[index],
    to = day.hours[Math.min(index + 1, day.hours.length - 1)];
  const next = new Map(
    to.floors.map((floor) => [floor.floor, floor.floor_actual_kw]),
  );
  const loads = Array<number>(day.meta.floors).fill(NaN);
  for (const floor of from.floors) {
    const a = floor.floor_actual_kw,
      b = next.get(floor.floor) ?? a;
    loads[floor.floor - 1] = a + (b - a) * fraction;
  }
  return loads;
}
