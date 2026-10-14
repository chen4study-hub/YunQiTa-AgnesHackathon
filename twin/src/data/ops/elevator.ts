import {
  OPS_DAY_MS,
  OPS_HOUR_MS,
  type OpsDay,
  type OpsElevator,
  type OpsElevatorState,
  type OpsMotionMeta,
  type OpsHour,
} from "./model";

/** Pure, absolute-time evaluation: share this result between the scene and list. */
export function evaluateElevator(
  lift: OpsElevator,
  meta: OpsMotionMeta,
  day_start_ms: number,
  at_ms: number,
): OpsElevatorState {
  if (![day_start_ms, at_ms].every(Number.isFinite))
    throw new RangeError("Ops time must be finite");
  const { floor_height_m: h, max_speed_m_s: v, acceleration_m_s2: a } = meta;
  if (
    meta.motion !== "trapezoidal_acceleration" ||
    ![h, v, a].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new Error("Ops elevator motion parameters invalid");
  const offset = at_ms - day_start_ms;
  let floor = lift.initial_floor;
  for (const trip of lift.trips) {
    if (offset < trip.depart_ms) break;
    floor = trip.to_floor;
    if (offset < trip.arrive_ms) {
      const d = Math.abs(trip.to_floor - trip.from_floor) * h;
      const t_acc = Math.min(v / a, Math.sqrt(d / a));
      const cruise = Math.max(0, (d - a * t_acc * t_acc) / v);
      const duration = 2 * t_acc + cruise;
      const segment = trip.arrive_ms - trip.depart_ms;
      if (segment <= 0) throw new Error("Ops elevator trip duration invalid");
      // Exported arrival is rounded to integer milliseconds. Map to the physical curve.
      const t = ((offset - trip.depart_ms) / segment) * duration;
      const speed = a * t_acc;
      const distance =
        t < t_acc
          ? 0.5 * a * t * t
          : t < t_acc + cruise
            ? 0.5 * a * t_acc * t_acc + speed * (t - t_acc)
            : d - 0.5 * a * (duration - t) * (duration - t);
      const direction = trip.to_floor > trip.from_floor ? 1 : -1;
      return {
        id: lift.id,
        floor: trip.from_floor + (direction * distance) / h,
        target: trip.to_floor,
        status: direction > 0 ? "up" : "down",
        direction,
        load_pct: trip.load_pct,
      };
    }
    if (offset < trip.arrive_ms + trip.dwell_ms)
      return {
        id: lift.id,
        floor,
        target: floor,
        status: "doors",
        direction: 0,
        load_pct: trip.load_pct,
      };
  }
  return {
    id: lift.id,
    floor,
    target: floor,
    status: "idle",
    direction: 0,
    load_pct: 0,
  };
}

/** No modulo or hour rounding: midnight requires a newly loaded calendar day. */
export function evaluateOpsSnapshot(
  day: OpsDay,
  at_ms: number,
): {
  at_ms: number;
  day_start_ms: number;
  hour: OpsHour;
  elevators: OpsElevatorState[];
} {
  const offset = at_ms - day.day_start_ms;
  if (!Number.isFinite(offset) || offset < 0 || offset >= OPS_DAY_MS)
    throw new RangeError("Ops snapshot time is outside this calendar day");
  const hour = day.hours.find(
    (row) => offset >= row.offset_ms && offset < row.offset_ms + OPS_HOUR_MS,
  );
  if (!hour) throw new RangeError("Ops snapshot hour missing");
  return {
    at_ms,
    day_start_ms: day.day_start_ms,
    hour,
    elevators: day.elevators.map((lift) =>
      evaluateElevator(lift, day.meta, day.day_start_ms, at_ms),
    ),
  };
}
