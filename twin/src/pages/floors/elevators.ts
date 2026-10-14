/** Bottom-edge coordinate; same mapping for cars, ticks and no-stop bands. */
export function liftFloorBottom(floor: number) {
  const p = (Math.max(1, Math.min(40, floor)) - 1) / 39;
  return `calc(${p * 100}% - ${p} * var(--floors-car-height))`;
}
export function elevatorOperatingStatus(loadPercent: number) {
  return loadPercent >= 80 ? "满载" : "正常";
}
export const ELEVATOR_PRESENTATION = {
  up: { symbol: "↑", label: "上行", color: "#4fd1d9" },
  down: { symbol: "↓", label: "下行", color: "#6b9fff" },
  doors: { symbol: "■", label: "停靠开门", color: "#9aa8b4" },
  idle: { symbol: "—", label: "待机", color: "#9aa8b4" },
} as const;
