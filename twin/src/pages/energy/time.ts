import { clockTime } from "../../data/interpolate";

export function energyClock(time: number): string {
  return clockTime(((time % 24) + 24) % 24);
}
/** Data hours are placed on the currently displayed LOCAL day, never playback's start day. */
export function energyPointMs(time: number, nowMs: number): number {
  const point = new Date(nowMs);
  point.setHours(0, 0, 0, 0);
  const whole = Math.floor(time);
  point.setHours(whole, 0, 0, 0);
  return point.getTime() + (time - whole) * 3_600_000;
}
function dateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function energyPointDateTime(time: number, nowMs: number): string {
  return `${dateKey(energyPointMs(time, nowMs))}T${energyClock(time)}`;
}
export function energyTimeLabel(
  time: number,
  nowMs: number,
  axis = false,
): string {
  const point = energyPointMs(time, nowMs);
  const prefix =
    dateKey(point) === dateKey(nowMs) ? "" : point < nowMs ? "昨日" : "次日";
  const clock = axis
    ? `${energyClock(time).slice(0, 2)}:00`
    : energyClock(time);
  return `${prefix}${prefix ? (axis ? "\n" : " ") : ""}${clock}`;
}
export function opsDateTime(atMs: number): string {
  const d = new Date(atMs);
  return `${dateKey(atMs)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
export function opsTimeLabel(atMs: number, nowMs: number): string {
  const point = new Date(atMs),
    now = new Date(nowMs);
  const pointDay = Date.UTC(
    point.getFullYear(),
    point.getMonth(),
    point.getDate(),
  );
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const prefix =
    pointDay === nowDay
      ? ""
      : pointDay === nowDay - 86400000
        ? "昨日 "
        : pointDay === nowDay + 86400000
          ? "次日 "
          : `${dateKey(atMs)} `;
  return `${prefix}${opsDateTime(atMs).slice(11, 16)}`;
}
export function energyCurrentTime(nowMs: number): number {
  const d = new Date(nowMs);
  return (
    d.getHours() +
    d.getMinutes() / 60 +
    d.getSeconds() / 3600 +
    d.getMilliseconds() / 3_600_000
  );
}
