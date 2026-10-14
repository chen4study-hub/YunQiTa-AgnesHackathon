import type { Hour, ReplayData, TwinFrame } from "./types";
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export function sampleFrame(data: ReplayData, time: number): TwinFrame {
  // Playback wraps the hourly cursor; interpolate 23:xx toward the same data's 00:00.
  const t = ((time % 24) + 24) % 24;
  const i = Math.floor(t),
    j = (i + 1) % 24,
    u = t - i;
  const a = data.hours[i],
    b = data.hours[j];
  const hour: Hour = {
    ...a,
    actual_kw: lerp(a.actual_kw, b.actual_kw, u),
    point_kw: lerp(a.point_kw, b.point_kw, u),
    lower_kw: lerp(a.lower_kw, b.lower_kw, u),
    upper_kw: lerp(a.upper_kw, b.upper_kw, u),
    confidence: lerp(a.confidence, b.confidence, u),
    risk_score: lerp(a.risk_score, b.risk_score, u),
    outdoor_temp_c:
      a.outdoor_temp_c === null || b.outdoor_temp_c === null
        ? a.outdoor_temp_c
        : lerp(a.outdoor_temp_c, b.outdoor_temp_c, u),
    floors_kw: a.floors_kw.map((value, floor) =>
      lerp(value, b.floors_kw[floor], u),
    ),
    storage: {
      power_kw: lerp(a.storage.power_kw, b.storage.power_kw, u),
      soc: lerp(a.storage.soc, b.storage.soc, u),
    },
    pv: { power_kw: lerp(a.pv.power_kw, b.pv.power_kw, u) },
    grid_kw: lerp(a.grid_kw, b.grid_kw, u),
  };
  return {
    hour,
    hourIndex: t,
    campus: data.campus.map((building) => {
      const x = building.hourly[i],
        y = building.hourly[j];
      return {
        abstain: x.abstain,
        point_kw:
          x.point_kw === null || y.point_kw === null
            ? x.point_kw
            : lerp(x.point_kw, y.point_kw, u),
      };
    }),
  };
}
/** No observed data after cursor, including fractional endpoints. */
export function observedPoints(
  data: ReplayData,
  time: number,
): [number, number][] {
  const frame = sampleFrame(data, time);
  const points: [number, number][] = data.hours
    .slice(0, Math.floor(frame.hourIndex) + 1)
    .map((hour, i) => [i, hour.actual_kw]);
  if (frame.hourIndex % 1) points.push([frame.hourIndex, frame.hour.actual_kw]);
  return points;
}
export function clockTime(time: number) {
  const seconds = Math.floor(time * 3600 + 1e-6);
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
