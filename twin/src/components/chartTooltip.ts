import type {
  EChartsOption,
  TooltipComponentOption,
  XAXisComponentOption,
} from "echarts";

const number = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  useGrouping: true,
});
const valueText = (value: unknown): string =>
  typeof value === "number"
    ? Number.isFinite(value)
      ? number.format(Number(value.toFixed(1)) || 0)
      : "—"
    : String(value ?? "暂无数据");
const defaultValueFormatter: NonNullable<
  TooltipComponentOption["valueFormatter"]
> = (value) =>
  Array.isArray(value) ? value.map(valueText).join(", ") : valueText(value);

/** Presentation-only defaults. Page/series/data-item formatters retain ECharts precedence. */
export function tooltipDefaults(option: EChartsOption): EChartsOption {
  const prepare = (
    tooltip: TooltipComponentOption = {},
  ): TooltipComponentOption => ({
    trigger: "axis",
    ...tooltip,
    ...(tooltip.formatter == null && tooltip.valueFormatter == null
      ? { valueFormatter: defaultValueFormatter }
      : {}),
    renderMode: "richText",
  });
  const tooltip = Array.isArray(option.tooltip)
    ? option.tooltip.map(prepare)
    : prepare(option.tooltip);
  const customTitle = (
    Array.isArray(option.tooltip) ? option.tooltip : [option.tooltip]
  ).some(
    (t) => t?.formatter != null || t?.axisPointer?.label?.formatter != null,
  );
  const globalPointer = !Array.isArray(option.axisPointer)
    ? option.axisPointer
    : undefined;
  const prepareAxis = (axis: XAXisComponentOption): XAXisComponentOption => {
    // Numeric hour axes already describe their clock convention on axisLabel.
    // Reuse that convention, not a guessed hour range (other numeric axes may be quantities).
    if (
      axis.type !== "value" ||
      customTitle ||
      globalPointer?.label?.formatter != null ||
      axis.axisPointer?.label?.formatter != null
    )
      return axis;
    const formatter = (
      axis.axisLabel as
        | { formatter?: string | ((value: number, index: number) => string) }
        | undefined
    )?.formatter;
    if (!formatter) return axis;
    return {
      ...axis,
      axisPointer: {
        ...axis.axisPointer,
        label: {
          ...axis.axisPointer?.label,
          formatter: ({ value }) =>
            typeof formatter === "function"
              ? formatter(Number(value), 0)
              : formatter.replace(/\{value\}/g, String(value)),
        },
      },
    };
  };
  return {
    ...option,
    tooltip,
    ...(option.xAxis
      ? {
          xAxis: Array.isArray(option.xAxis)
            ? option.xAxis.map(prepareAxis)
            : prepareAxis(option.xAxis),
        }
      : {}),
  };
}
