import { chartTypography } from "./typography";
import type { EChartsOption } from "echarts";
import type { ForecastView } from "./types";
import type { OverviewSlot } from "../../data/overviewForecast";
import {
  confidenceThresholds,
  number,
  percent,
  peakPoint,
  timeLabel,
  shiftTime,
} from "./data";

export function forecastOption(
  view: ForecastView,
  labelOrigin = view.current_t,
): EChartsOption {
  const future = view.forecast_24h;
  const peak = peakPoint(view);
  const peakIndex = future.indexOf(peak) + 1;
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    aria: { enabled: true },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      formatter: (params) => {
        const rows = Array.isArray(params) ? params : [params];
        const row = rows.find(
          (p) => p.seriesName === "预测" || p.seriesName === "实测",
        );
        if (!row) return "";
        if (row.seriesName === "实测" || row.dataIndex === 0) {
          const p =
            row.seriesName === "实测"
              ? view.recent_actual[row.dataIndex]
              : view.recent_actual[1];
          return `${timeLabel(p.t, labelOrigin)}\n原始观测  ${number(p.actual_kw)} kW`;
        }
        const p = future[row.dataIndex - 1];
        return `${timeLabel(p.t, labelOrigin)}\n预测  ${number(p.point_kw)} kW\n90% 区间  ${number(p.lower_kw)} – ${number(p.upper_kw)} kW\n宽度  ${number(p.upper_kw - p.lower_kw)} kW\n置信度评分  ${percent(p.confidence)}\n${p.realized_abstain ? "拒绝预测 · 转人工" : "可信范围内"}`;
      },
    },
    grid: { left: 56, right: 40, top: 30, bottom: 28 },
    legend: { show: false },
    xAxis: {
      type: "value",
      min: -1,
      max: 24,
      interval: 3,
      axisLabel: {
        color: "#b8cbd4",
        hideOverlap: true,
        showMaxLabel: false,
        formatter: (v: number) =>
          timeLabel(shiftTime(view.current_t, v), labelOrigin),
      },
      splitLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "负荷 / kW",
      scale: true,
      axisLabel: { formatter: (v: number) => number(v, 0) },
      splitLine: { lineStyle: { color: "#233442" } },
    },
    series: [
      {
        type: "line",
        id: "forecast-lower",
        name: "区间下界",
        stack: "interval",
        stackStrategy: "all",
        // First numeric dimension is the stacked value, not the time offset.
        dimensions: ["load", "offset"],
        encode: { x: "offset", y: "load" },
        data: future.map((p, i) => [p.lower_kw, i + 1]),
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
      },
      {
        type: "line",
        id: "forecast-width",
        name: "90% 区间宽度",
        stack: "interval",
        stackStrategy: "all",
        dimensions: ["load", "offset"],
        encode: { x: "offset", y: "load" },
        data: future.map((p, i) => [p.upper_kw - p.lower_kw, i + 1]),
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: "#4fd1d9", opacity: 0.2 },
        silent: true,
        tooltip: { show: false },
      },
      {
        type: "line",
        id: "forecast-actual",
        name: "实测",
        data: view.recent_actual.map((p, i) => [i - 1, p.actual_kw]),
        symbol: "circle",
        symbolSize: 7,
        lineStyle: { color: "#f4f7fb", width: 3 },
        itemStyle: { color: "#f4f7fb" },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#4fd1d9", type: "dashed", width: 2 },
          label: {
            formatter: `t · ${timeLabel(view.current_t, labelOrigin)}`,
            color: "#4fd1d9",
            position: "insideStartTop",
            rotate: 0,
            distance: 8,
            offset: [8, -4],
            align: "left",
            backgroundColor: "#0c131b",
            padding: [3, 6],
          },
          data: [{ xAxis: 0 }],
        },
      },
      {
        type: "line",
        id: "forecast-future",
        name: "预测",
        data: [
          [0, view.recent_actual[1].actual_kw],
          ...future.map((p, i) => [i + 1, p.point_kw]),
        ],
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { color: "#4fd1d9", width: 2.5 },
        itemStyle: { color: "#4fd1d9" },
        markArea: {
          silent: true,
          itemStyle: { color: "rgba(255,77,94,0.15)" },
          label: { show: false },
          data: future.flatMap((p, i) =>
            p.realized_abstain
              ? [[{ xAxis: i + 0.5 }, { xAxis: i + 1.5 }]]
              : [],
          ),
        },
        markPoint: {
          symbol: "pin",
          symbolSize: 45,
          itemStyle: { color: "#225661" },
          label: { formatter: "峰值", color: "#e9f8fa" },
          data: [
            {
              name: "未来24h峰值",
              coord: [peakIndex, peak.point_kw],
              value: peak.point_kw,
            },
          ],
        },
      },
    ],
  };
}
/** Adapt the public overviewWindow slots; no independent actual/gate/window logic. */
export function playbackForecastOption(
  view: ForecastView,
  slots: readonly OverviewSlot[],
  baseTime: string,
  origin: number,
  head: number,
): EChartsOption {
  const labelOrigin = shiftTime(baseTime, Math.floor(head) - origin);
  const label = (t: number) =>
    timeLabel(shiftTime(baseTime, t - origin), labelOrigin);
  const option = forecastOption(view, labelOrigin);
  const series = option.series as any[];
  const low = series.find((s) => s.id === "forecast-lower");
  const width = series.find((s) => s.id === "forecast-width");
  const actual = series.find((s) => s.id === "forecast-actual");
  const future = series.find((s) => s.id === "forecast-future");
  low.data = slots.map((p) => [p.lower, p.t]);
  width.data = slots.map((p) => [
    p.upper === null || p.lower === null ? null : p.upper - p.lower,
    p.t,
  ]);
  actual.data = slots.map((p) => [p.t, p.actual]);
  actual.markLine.data = [];
  future.data = slots.map((p) => [p.t, p.point]);
  future.markArea.data = slots.flatMap((p) =>
    p.realized_abstain ? [[{ xAxis: p.t - 0.5 }, { xAxis: p.t + 0.5 }]] : [],
  );
  const remaining = slots.filter(
    (p) => p.t > Math.floor(head) && p.point !== null,
  );
  const peak = remaining.reduce<OverviewSlot | null>(
    (best, p) => (!best || p.point! > best.point! ? p : best),
    null,
  );
  future.markPoint.data = peak
    ? [{ name: "剩余预测峰值", coord: [peak.t, peak.point], value: peak.point }]
    : [];
  const x = option.xAxis as {
    min: number;
    max: number;
    axisLabel: { formatter: (v: number) => string };
  };
  x.min = slots[0].t;
  x.max = slots[slots.length - 1].t;
  x.axisLabel.formatter = label;
  option.tooltip = {
    trigger: "axis",
    renderMode: "richText",
    formatter: (params) => {
      const rows = Array.isArray(params) ? params : [params];
      const row = rows.find(
        (p) => p.seriesName === "实测" || p.seriesName === "预测",
      );
      if (!row) return "";
      const slot = slots[row.dataIndex];
      if (!slot) return "";
      const rejection = slot.realized_abstain ? "\n拒绝预测 · 转人工" : "";
      if (slot.actual !== null)
        return `${label(slot.t)}\n实测 ${number(slot.actual)} kW${rejection}`;
      const confidence =
        view.forecast_24h[slot.t - Math.floor(head) - 1]?.confidence;
      return `${label(slot.t)}\n预测 ${number(slot.point!)} kW\n90% 区间 ${number(slot.lower!)} – ${number(slot.upper!)} kW${confidence === undefined ? "" : `\n置信度评分 ${percent(confidence)}`}${rejection}`;
    },
  };
  option.animation = false;
  return option;
}
export function confidenceOption(
  view: ForecastView,
  labelOrigin = view.current_t,
): EChartsOption {
  const thresholds = confidenceThresholds(view);
  const scores = [
    ...view.forecast_24h.map((p) => p.confidence * 100),
    ...thresholds.filter((v): v is number => v !== null).map((v) => v * 100),
  ];
  const minimum = Math.max(0, Math.floor((Math.min(...scores) - 3) / 5) * 5);
  const maximum = Math.min(100, Math.ceil((Math.max(...scores) + 3) / 5) * 5);
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    aria: { enabled: true },
    grid: { left: 40, right: 12, top: 8, bottom: 24 },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      formatter: (params) => {
        const row = Array.isArray(params) ? params[0] : params;
        const p = view.forecast_24h[row.dataIndex];
        const threshold = thresholds[row.dataIndex];
        return `${timeLabel(p.t, labelOrigin)}\n置信度评分 ${percent(p.confidence)}\n阈值 ${threshold === null ? "暂无数据" : percent(threshold)}\n${p.realized_abstain ? "拒绝 · 转人工" : "通过门控"}`;
      },
    },
    xAxis: {
      type: "category",
      data: view.forecast_24h.map((p) => timeLabel(p.t, labelOrigin)),
      axisLabel: { interval: 5, hideOverlap: true, color: "#b8cbd4" },
    },
    yAxis: {
      type: "value",
      min: minimum,
      max: maximum,
      splitNumber: 2,
      axisLabel: {
        formatter: (v: number) => `${number(v, 0)}%`,
        hideOverlap: true,
      },
      splitLine: { lineStyle: { color: "#233442" } },
    },
    series: [
      {
        type: "bar",
        id: "forecast-confidence",
        name: "置信度评分",
        data: view.forecast_24h.map((p) => ({
          value: p.confidence * 100,
          itemStyle: { color: p.realized_abstain ? "#ff8493" : "#4fd1d9" },
        })),
        barMaxWidth: 14,
      },
      {
        type: "line",
        id: "forecast-threshold",
        name: "门控阈值",
        data: thresholds.map((v) => (v === null ? null : v * 100)),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: "#f1bd70", type: "dashed", width: 2 },
        z: 4,
      },
    ],
  };
}
export function floorOption(loads: number[]): EChartsOption {
  const values = Array.from({ length: 40 }, (_, i) =>
    Number.isFinite(loads[i]) ? loads[i] : null,
  );
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    aria: { enabled: true },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      formatter: (p) => {
        const row = Array.isArray(p) ? p[0] : p;
        const value = values[row.dataIndex];
        return `${row.dataIndex + 1}F · 分配负荷\n${value === null ? "暂无数据" : `${number(value)} kW`}`;
      },
    },
    grid: { left: 44, right: 12, top: 32, bottom: 28 },
    xAxis: {
      type: "category",
      data: values.map((_, i) => `${i + 1}F`),
      axisLabel: { interval: 4, color: "#b8cbd4" },
    },
    yAxis: {
      type: "value",
      name: "kW",
      nameGap: 8,
      nameTextStyle: { fontSize: chartTypography().label, lineHeight: 16 },
      min: 0,
      axisLabel: { formatter: (v: number) => number(v, 0) },
      splitLine: { lineStyle: { color: "#233442" } },
    },
    visualMap: {
      type: "continuous",
      min: 0,
      max,
      dimension: 1,
      show: false,
      inRange: { color: ["#326e87", "#5bd4da", "#f1bd70"] },
    },
    series: [
      {
        type: "bar",
        id: "forecast-floors",
        name: "楼层分配负荷",
        barMaxWidth: 18,
        data: values.map((v, i) => [i, v]),
      },
    ],
  };
}
