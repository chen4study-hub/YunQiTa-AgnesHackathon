import { formatNumber } from "../../ui/numberFormat";

/** Presentation-only rich-text tooltips: never stringify raw interpolated floats. */
export function tooltipNumber(value: unknown, unit = ""): string {
  const numeric = Number(value);
  const fixedDecimal = ["kW", "kWh", "℃", "°C", "元"].includes(unit);
  const integer = unit === "人" || unit === "ppm";
  const text = Number.isFinite(numeric)
    ? fixedDecimal || integer
      ? formatNumber(numeric, fixedDecimal ? 1 : 0)
      : numeric.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 1,
        })
    : "—";
  return `${text}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;
}
export function tooltipHour(value: unknown): string {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return "—";
  const minutes = Math.round(hour * 60),
    day = Math.floor(minutes / 1440),
    wrapped = ((minutes % 1440) + 1440) % 1440;
  const clock = `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  return `${day > 0 ? "次日 " : day < 0 ? "昨日 " : ""}${clock}`;
}
interface TooltipPoint {
  seriesName?: string;
  name?: string;
  value?: unknown;
  percent?: number;
  axisValue?: unknown;
}
export function seriesTooltip(
  params: TooltipPoint | TooltipPoint[],
  units: Record<string, string>,
  timed = true,
): string {
  const rows = Array.isArray(params) ? params : [params],
    first = rows[0];
  if (!first) return "";
  const value = Array.isArray(first.value) ? first.value[0] : first.axisValue;
  const title = timed ? tooltipHour(value) : (first.name ?? "");
  return [
    title,
    ...rows.map((row) => {
      const value = Array.isArray(row.value)
        ? row.value[row.value.length - 1]
        : row.value;
      const name = (!timed ? row.name : row.seriesName) || row.name || "负荷";
      return `${name}  ${tooltipNumber(value, units[name] ?? units.default ?? "")}${row.percent !== undefined ? ` · ${tooltipNumber(row.percent, "%")}` : ""}`;
    }),
  ]
    .filter(Boolean)
    .join("\n");
}
