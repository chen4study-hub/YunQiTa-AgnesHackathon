import { expect, it } from "vitest";
import type { TooltipComponentOption, XAXisComponentOption } from "echarts";
import { chartPresentation } from "../src/components/chartUpdate";
import { tooltipDefaults } from "../src/components/chartTooltip";

const tooltip = (option = {}) =>
  chartPresentation(option, false).tooltip as TooltipComponentOption;
const values = (option = {}) => tooltip(option).valueFormatter!;
const clock = (value: number) =>
  `${value >= 24 ? "次日 " : ""}${String(Math.floor(value % 24)).padStart(2, "0")}:${String(Math.round((value % 1) * 60)).padStart(2, "0")}`;

it("defaults to grouped numbers with at most one decimal and safe missing/nonfinite values", () => {
  const format = values();
  expect(format(381.5224997184777, 0)).toBe("381.5");
  expect(format(12345.6789, 0)).toBe("12,345.7");
  expect(format(1200, 0)).toBe("1,200");
  expect(format(-0, 0)).toBe("0");
  expect(format(-0.001, 0)).toBe("0");
  expect(format(NaN, 0)).toBe("—");
  expect(format(null, 0)).toBe("暂无数据");
  expect(format([18, 12345.6789], 0)).toBe("18, 12,345.7");
  expect(tooltip().renderMode).toBe("richText");
});
it("preserves custom callbacks/templates and a two-decimal price valueFormatter", () => {
  const formatter = () => "original price 0.82";
  expect(tooltip({ tooltip: { formatter } }).formatter).toBe(formatter);
  expect(tooltip({ tooltip: { formatter } }).valueFormatter).toBeUndefined();
  expect(tooltip({ tooltip: { formatter: "{b}: {c}" } }).formatter).toBe(
    "{b}: {c}",
  );
  expect(
    tooltip({ tooltip: { formatter: "" } }).valueFormatter,
  ).toBeUndefined();
  const valueFormatter = (value: unknown) => Number(value).toFixed(2);
  expect(values({ tooltip: { valueFormatter } })).toBe(valueFormatter);
  expect(values({ tooltip: { valueFormatter } })(0.819, 0)).toBe("0.82");
});
it("retains series and data-item formatting, input identity and array tooltips", () => {
  const valueFormatter = () => "0.82 元/kWh",
    formatter = () => "item";
  const series = [
    {
      type: "line" as const,
      tooltip: { valueFormatter },
      data: [{ value: 0.819, tooltip: { formatter } }],
    },
  ];
  const input = {
    tooltip: [{ trigger: "item" as const }, { valueFormatter }],
    series,
  };
  const result = tooltipDefaults(input);
  expect(result.series).toBe(series);
  expect(input.tooltip[0]).not.toHaveProperty("valueFormatter");
  const tooltips = result.tooltip as TooltipComponentOption[];
  expect(tooltips[0].trigger).toBe("item");
  expect(tooltips[0].valueFormatter!(381.5224997184777, 0)).toBe("381.5");
  expect(tooltips[1].valueFormatter).toBe(valueFormatter);
});
it("reuses the numeric hour axis clock format for tooltip titles, including fractional and next-day hours", () => {
  const xAxis = {
    type: "value" as const,
    axisLabel: { formatter: clock },
    axisPointer: { label: { show: false } },
  };
  const result = chartPresentation({ xAxis }, false)
    .xAxis as XAXisComponentOption;
  const formatter = result.axisPointer!.label!.formatter as (p: {
    value: number;
  }) => string;
  for (const hour of [18, 18.5, 24])
    expect(formatter({ value: hour })).toBe(clock(hour));
  expect(formatter({ value: 18 })).toBe("18:00");
  expect(result.axisPointer!.label!.show).toBe(false);
  expect(xAxis.axisPointer.label).not.toHaveProperty("formatter");
});
it("handles axis arrays/templates without turning plain numeric or category axes into hours", () => {
  const axes = [
    { type: "value" as const, axisLabel: { formatter: "{value}:00" } },
    { type: "value" as const },
    { type: "category" as const, data: ["A"] },
  ];
  const result = tooltipDefaults({ xAxis: axes })
    .xAxis as XAXisComponentOption[];
  const format = result[0].axisPointer!.label!.formatter as (p: {
    value: number;
  }) => string;
  expect(format({ value: 18 })).toBe("18:00");
  expect(result[1]).toBe(axes[1]);
  expect(result[2]).toBe(axes[2]);
});
it("does not replace existing tooltip titles or axis-pointer formatters", () => {
  const pointer = () => "explicit title";
  const xAxis = { type: "value" as const, axisLabel: { formatter: clock } };
  expect(
    tooltipDefaults({ xAxis, tooltip: { formatter: () => "page" } }).xAxis,
  ).toBe(xAxis);
  expect(
    tooltipDefaults({
      xAxis,
      tooltip: { axisPointer: { label: { formatter: pointer } } },
    }).xAxis,
  ).toBe(xAxis);
  expect(
    tooltipDefaults({ xAxis, axisPointer: { label: { formatter: pointer } } })
      .xAxis,
  ).toBe(xAxis);
  const explicit = { ...xAxis, axisPointer: { label: { formatter: pointer } } };
  expect(tooltipDefaults({ xAxis: explicit }).xAxis).toBe(explicit);
});
