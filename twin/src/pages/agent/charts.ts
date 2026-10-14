import { chartTypography } from "../forecast/typography";
import type { EChartsOption } from "echarts";
import type { ReplayData } from "../../data/types";
import type { Decision } from "./types";
import { n, finite, costWindowLabel } from "./data";
import { timeLabel } from "../forecast/data";

export function candidateOption(decision: Decision): EChartsOption {
  const fonts = chartTypography();
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    aria: { enabled: true },
    grid: { left: 70, right: 70, top: 4, bottom: 18 },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      textStyle: { fontSize: fonts.body },
      valueFormatter: (value) => (finite(value) ? n(value) : "暂无数据"),
    },
    xAxis: {
      type: "value",
      min: 0,
      // Unit is in the chart heading; an end-axis name collides with bar labels.
      name: "",
      splitNumber: 2,
      nameTextStyle: { fontSize: fonts.label },
      axisLabel: {
        fontSize: fonts.label,
        formatter: (v: number) => n(v, 0),
        hideOverlap: true,
      },
      splitLine: { lineStyle: { color: "#233442" } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: decision.candidates.map((c) => c.name),
      axisLabel: { color: "#b8cbd4", fontSize: fonts.label, interval: 0 },
    },
    series: [
      {
        type: "bar",
        id: "candidate-cost",
        name: `${costWindowLabel(decision)}电费`,
        barMaxWidth: 16,
        labelLayout: { moveOverlap: "shiftY" },
        label: {
          show: true,
          position: "right",
          fontSize: fonts.label,
          lineHeight: 16,
          formatter: (p) => (finite(p.value) ? n(p.value) : "暂无数据"),
          color: "#b8cbd4",
        },
        data: decision.candidates.map((c) => ({
          value: c.cost,
          itemStyle: {
            color: c.id === decision.selected ? "#4fd1d9" : "#456d82",
          },
        })),
      },
    ],
  };
}
/** Show the selected typical day's discrete hourly risk (not future actuals).
 * Forecast 1.2 risk fields take priority for the rolling future horizon.
 */
export function riskOption(
  data: ReplayData,
  index: number,
  labelOrigin = data.hours[index].t,
): EChartsOption {
  const h = data.hours[index] as (typeof data.hours)[number] & {
    forecast_24h?: {
      t: string;
      risk_score?: number;
      risk_threshold?: number;
    }[];
  };
  const fonts = chartTypography();
  const future = h.forecast_24h;
  const rows =
    future?.length === 24 &&
    future.every((p) => finite(p.risk_score) && finite(p.risk_threshold))
      ? future
      : data.hours;
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    aria: { enabled: true },
    grid: { left: 36, right: 12, top: 8, bottom: 24 },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      textStyle: { fontSize: fonts.body },
      valueFormatter: (value) => (finite(value) ? n(value) : "暂无数据"),
    },
    xAxis: {
      type: "category",
      data: rows.map((p) => timeLabel(p.t, labelOrigin)),
      nameTextStyle: { fontSize: fonts.label },
      axisLabel: {
        fontSize: fonts.label,
        interval: 3,
        hideOverlap: true,
        color: "#b8cbd4",
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 1,
      splitNumber: 2,
      nameTextStyle: { fontSize: fonts.label },
      axisLabel: { fontSize: fonts.label, hideOverlap: true },
      splitLine: { lineStyle: { color: "#233442" } },
    },
    series: [
      {
        type: "bar",
        id: "risk_score",
        name: "risk_score",
        barMaxWidth: 14,
        data: rows.map((p) => ({
          value: p.risk_score,
          itemStyle: {
            color: p.risk_score! > p.risk_threshold! ? "#ff8493" : "#4fd1d9",
          },
        })),
      },
      {
        type: "line",
        id: "risk_threshold",
        name: "risk_threshold",
        data: rows.map((p) => p.risk_threshold),
        symbol: "none",
        lineStyle: { color: "#f1bd70", type: "dashed", width: 2 },
      },
    ],
  };
}
