import { darkTheme } from "../../ui/chartTheme";
/** ECharts needs numbers, so resolve the public CSS tokens at the chart host. */
export function chartTypography(host?: Element) {
  const element =
    host ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  const style = element ? getComputedStyle(element) : undefined;
  const pixels = (token: string, fallback: number) => {
    const n = parseFloat(style?.getPropertyValue(token) ?? "");
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    label: pixels("--font-label", darkTheme.textStyle.fontSize),
    legend: pixels("--font-legend", darkTheme.legend.textStyle.fontSize),
    body: pixels("--font-body", darkTheme.tooltip.textStyle.fontSize),
  };
}
