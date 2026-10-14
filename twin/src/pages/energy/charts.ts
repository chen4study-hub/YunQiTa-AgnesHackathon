import type { EChartsOption } from "echarts";
import {
  OPS_HOUR_MS,
  type OpsDay,
  type OpsWindow,
  type OpsHour,
} from "../../data/ops";
import { endUseRows, energyNumber, environmentAt } from "./data";
import { energyTimeLabel } from "./time";
import { seriesTooltip } from "./tooltips";

/** Full day or an explicitly loaded calendar window, never %24 template repetition. */
export function chartHours(data: OpsDay | OpsWindow, nowMs: number) {
  const anchor = new Date(nowMs);
  anchor.setHours(0, 0, 0, 0);
  const rows =
    "days" in data
      ? data.hours.map((row) => ({ hour: row.hour, at: row.at_ms }))
      : data.hours.map((hour) => ({
          hour,
          at: data.day_start_ms + hour.offset_ms,
        }));
  return rows.map(({ hour, at }) => ({
    hour,
    t: (at - anchor.getTime()) / OPS_HOUR_MS,
  }));
}
export function opsTimeAxis(data: OpsDay | OpsWindow, nowMs: number) {
  const points = chartHours(data, nowMs);
  const min = "days" in data ? (points[0]?.t ?? 0) : 0;
  return {
    type: "value" as const,
    min,
    max: "days" in data ? (points.at(-1)?.t ?? 23) + 1 : min + 24,
    interval: 6,
    axisLabel: {
      ...axisLabel,
      formatter: (value: number) => energyTimeLabel(value, nowMs, true),
    },
  };
}

const axisLabel = { color: "#8597a3" };
const splitLine = { lineStyle: { color: "#1c2a36" } };
const cursor = (time: number) => ({
  xAxis: time,
  lineStyle: { color: "#4fd1d9", width: 1, type: "solid" as const },
  label: {
    // Readable horizontal cursor time lives in the card header, outside the plot.
    show: false,
    position: "insideEndTop" as const,
    color: "#4fd1d9",
  },
});
export function endUseChart(hour: OpsHour): EChartsOption {
  return {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      formatter: (params) => seriesTooltip(params, { default: "kW" }, false),
    },
    series: [
      {
        name: "分项能耗",
        type: "pie",
        radius: ["65%", "88%"],
        center: ["50%", "50%"],
        label: { show: false },
        emphasis: { scale: false },
        data: endUseRows(hour).map((item) => ({
          name: item.name,
          value: item.value,
          itemStyle: {
            color: item.color,
            borderColor: "#0c131b",
            borderWidth: 3,
          },
        })),
      },
    ],
  };
}
/** Stable full-day/window bounds with headroom; null channels never fabricate readings. */
export function roundedAxisMax(values: readonly (number | null)[], step = 500) {
  return Math.max(
    step,
    Math.ceil((Math.max(0, ...values.map((v) => v ?? 0)) * 1.1) / step) * step,
  );
}
export function temperatureAxis(values: readonly number[]) {
  return {
    min: Math.min(22, Math.floor(Math.min(...values, 22))),
    max: Math.max(28, Math.ceil(Math.max(...values, 27) + 1)),
  };
}
export function emsChart(
  data: OpsDay | OpsWindow,
  time: number,
  nowMs: number = Date.now(),
): EChartsOption {
  const points = chartHours(data, nowMs);
  const storageMax = roundedAxisMax(
    points.map(({ hour }) => Math.abs(hour.storage.power_kw ?? 0)),
    100,
  );
  const pvMax = roundedAxisMax(
    points.map(({ hour }) => hour.pv.power_kw),
    100,
  );
  return {
    animation: false,
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      formatter: (params) => seriesTooltip(params, { default: "kW" }),
    },
    legend: {
      top: 0,
      data: ["放电", "充电", "光伏"],
      textStyle: { color: "#a8bac7" },
      itemWidth: 12,
    },
    grid: { left: 48, right: 44, top: 32, bottom: 42 },
    xAxis: opsTimeAxis(data, nowMs),
    yAxis: [
      {
        type: "value",
        min: -storageMax,
        max: storageMax,
        interval: storageMax,
        name: "",
        axisLabel: { ...axisLabel, formatter: (v: number) => energyNumber(v) },
        splitLine,
      },
      {
        type: "value",
        min: 0,
        max: pvMax,
        interval: pvMax / 2,
        name: "",
        axisLabel: { ...axisLabel, formatter: (v: number) => energyNumber(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "放电",
        type: "bar",
        stack: "storage",
        barWidth: 7,
        itemStyle: { color: "#2fbf8f" },
        data: chartHours(data, nowMs).map(({ hour, t }) => [
          t,
          hour.storage.power_kw === null
            ? null
            : Math.max(0, hour.storage.power_kw),
        ]),
        markLine: { silent: true, symbol: "none", data: [cursor(time)] },
      },
      {
        name: "充电",
        type: "bar",
        stack: "storage",
        barWidth: 7,
        itemStyle: { color: "#6b9fff" },
        data: chartHours(data, nowMs).map(({ hour, t }) => [
          t,
          hour.storage.power_kw === null
            ? null
            : Math.min(0, hour.storage.power_kw),
        ]),
      },
      {
        name: "光伏",
        type: "line",
        yAxisIndex: 1,
        symbol: "none",
        lineStyle: { color: "#e5be6a", width: 2 },
        itemStyle: { color: "#e5be6a" },
        data: chartHours(data, nowMs).map(({ hour, t }) => [
          t,
          hour.pv.power_kw,
        ]),
      },
    ],
  };
}
export function environmentChart(
  data: OpsDay | OpsWindow,
  time: number,
  nowMs: number = Date.now(),
): EChartsOption {
  const points = chartHours(data, nowMs).map(({ hour, t }) => ({
    ...environmentAt(hour),
    t,
  }));
  // Two equal intervals, each a multiple of 500. Explicit bounds prevent an
  // extra endpoint label beside the last automatically chosen nice tick.
  const peopleMax = roundedAxisMax(
    points.map((point) => point.people),
    1000,
  );
  const co2Max = roundedAxisMax(
    [1000, ...points.map((point) => point.co2_ppm)],
    1000,
  );
  return {
    animation: false,
    legend: {
      top: 0,
      textStyle: { color: "#a8bac7" },
      itemWidth: 12,
    },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      formatter: (params) =>
        seriesTooltip(params, { 在楼人数: "人", "CO₂": "ppm" }),
    },
    grid: { left: 54, right: 54, top: 32, bottom: 42 },
    xAxis: opsTimeAxis(data, nowMs),
    yAxis: [
      {
        type: "value",
        min: 0,
        max: peopleMax,
        interval: peopleMax / 2,
        name: "",
        axisLabel: { ...axisLabel, formatter: (v: number) => energyNumber(v) },
        splitLine,
      },
      {
        type: "value",
        min: 0,
        max: co2Max,
        interval: co2Max / 2,
        name: "",
        axisLabel: { ...axisLabel, formatter: (v: number) => energyNumber(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "在楼人数",
        type: "line",
        symbol: "none",
        lineStyle: { color: "#4fd1d9", width: 2 },
        itemStyle: { color: "#4fd1d9" },
        areaStyle: { color: "#4fd1d911" },
        data: points.map((point) => [point.t, point.people]),
        markLine: { silent: true, symbol: "none", data: [cursor(time)] },
      },
      {
        name: "CO₂",
        type: "line",
        yAxisIndex: 1,
        symbol: "none",
        lineStyle: { color: "#e5be6a", width: 2 },
        itemStyle: { color: "#e5be6a" },
        data: points.map((point) => [point.t, point.co2_ppm]),
        markLine: {
          silent: true,
          symbol: "none",
          label: {
            color: "#ff4d5e",
            formatter: "1,000 ppm",
            position: "insideEndTop",
            padding: [2, 4],
            backgroundColor: "#0c131bcc",
          },
          lineStyle: { color: "#ff4d5e", type: "dotted" },
          data: [{ yAxis: 1000 }],
        },
      },
    ],
  };
}
