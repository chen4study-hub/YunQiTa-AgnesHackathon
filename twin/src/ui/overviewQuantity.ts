import { formatNumber } from "./numberFormat";

// Display-only: never change source measurements, timestamps, IDs or axis ticks.
export const overviewQuantityPattern = String.raw`(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?\s*(?:元/kWh|kWh|kW|元|°C|℃)`;
export function formatOverviewQuantities(text: string): string {
  return text.replace(new RegExp(overviewQuantityPattern, "g"), (quantity) => {
    const [, numeric, unit] = quantity.match(
      /^([-+]?\d[\d,]*(?:\.\d+)?)\s*(.*)$/,
    )!;
    return `${formatNumber(Number(numeric.replaceAll(",", "")), unit === "元/kWh" ? 2 : 1)} ${unit}`;
  });
}
