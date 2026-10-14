import type { Hour, ModelCard, ReplayData } from "../../data/types";
import { predictionWindow } from "../../data/forecast";
import type {
  ForecastPoint,
  ForecastView,
  ForecastWindow,
  RejectedSlot,
} from "./types";

import { formatPageNumber } from "../displayNumbers";
export const number = (value: number, digits = 1) =>
  formatPageNumber(value, digits === 0 ? "integer" : "number");
export const percent = (value: number) => formatPageNumber(value, "percent");
const HOUR = 3_600_000;

/** Preserve the replay's wall-clock timezone, including midnight rollover. */
export function shiftTime(t: string, hours: number): string {
  const suffix = t.match(/(Z|[+-]\d{2}:\d{2})$/)?.[0] ?? "Z";
  const wall = t.replace(/(Z|[+-]\d{2}:\d{2})$/, "");
  return (
    new Date(Date.parse(`${wall}Z`) + hours * HOUR).toISOString().slice(0, 19) +
    suffix
  );
}
export function timeLabel(t: string, origin?: string): string {
  const clock = t.slice(11, 16);
  if (!origin || t.slice(0, 10) === origin.slice(0, 10)) return clock;
  const delta = Math.round(
    (Date.parse(`${t.slice(0, 10)}T00:00Z`) -
      Date.parse(`${origin.slice(0, 10)}T00:00Z`)) /
      (24 * HOUR),
  );
  return `${delta === 1 ? "次日" : delta === -1 ? "昨日" : t.slice(5, 10)} ${clock}`;
}
function validPoint(p: ForecastPoint, expected: string): boolean {
  return (
    p &&
    Date.parse(p.t) === Date.parse(expected) &&
    [p.point_kw, p.lower_kw, p.upper_kw, p.confidence].every(Number.isFinite) &&
    p.lower_kw >= 0 &&
    p.lower_kw <= p.point_kw &&
    p.point_kw <= p.upper_kw &&
    p.confidence >= 0 &&
    p.confidence <= 1 &&
    typeof p.abstain === "boolean"
  );
}
export function validWindow(
  value: ForecastWindow | undefined,
  t: string,
): value is ForecastWindow {
  return (
    !!value &&
    Array.isArray(value.forecast_24h) &&
    value.forecast_24h.length === 24 &&
    value.forecast_24h.every((p, i) => validPoint(p, shiftTime(t, i + 1))) &&
    Array.isArray(value.recent_actual) &&
    value.recent_actual.length === 2 &&
    value.recent_actual.every(
      (p, i) =>
        p &&
        Number.isFinite(p.actual_kw) &&
        p.actual_kw >= 0 &&
        Date.parse(p.t) === Date.parse(shiftTime(t, i - 1)),
    )
  );
}

/** Deterministic compatibility mock: repeat the selected typical-day profile.
 * Previous midnight observation is explicitly synthetic; no future actuals are exposed.
 * Next-day values are NOT a new model run or verified multi-horizon uncertainty.
 */
export function mockWindow(data: ReplayData, hour: number): ForecastView {
  const index = Math.max(0, Math.min(23, Math.floor(hour)));
  const current = data.hours[index];
  const reasons: Record<string, string | null> = {};
  const forecast_24h = Array.from({ length: 24 }, (_, i) => {
    const h = data.hours[(index + i + 1) % 24];
    const t = shiftTime(current.t, i + 1);
    reasons[t] = h.abstain_reason;
    return {
      t,
      point_kw: h.point_kw,
      lower_kw: h.lower_kw,
      upper_kw: h.upper_kw,
      confidence: h.confidence,
      abstain: h.abstain,
    };
  });
  return {
    current_t: current.t,
    source: "mock",
    forecast_24h,
    reasons,
    confidence_threshold: data.meta.confidence_threshold,
    recent_actual: [
      {
        t: shiftTime(current.t, -1),
        actual_kw: data.hours[(index + 23) % 24].actual_kw,
      },
      { t: current.t, actual_kw: current.actual_kw },
    ],
    note: `周期参考数据 · 90% 预测区间${index === 0 ? " · 昨日观测为周期参考值" : ""}`,
  };
}
function originForecastView(data: ReplayData, time: number): ForecastView {
  const index = Math.max(0, Math.min(23, Math.floor(time)));
  const current = data.hours[index] as Hour & Partial<ForecastWindow>;
  if (validWindow(current as ForecastWindow, current.t))
    return {
      current_t: current.t,
      source: "contract-1.2",
      forecast_24h: current.forecast_24h!,
      recent_actual: current.recent_actual!,
      reasons: Object.fromEntries(
        current.forecast_24h!.map((p) => [p.t, forecastReason(p)]),
      ),
      confidence_threshold: data.meta.confidence_threshold,
      note: "每小时滚动预测 · 90% 预测区间",
    };
  return mockWindow(data, index);
}
export function forecastView(data: ReplayData, time: number): ForecastView {
  const index = Math.max(0, Math.min(23, Math.floor(time)));
  const view = originForecastView(data, index);
  // Legacy compatibility supplies a window, but gate semantics remain owned by
  // the public predictionWindow (never derive them from the origin forecast).
  const input =
    view.source === "mock"
      ? {
          ...data,
          hours: data.hours.map((h, i) =>
            i === index
              ? {
                  ...h,
                  recent_actual: [...view.recent_actual],
                  forecast_24h: view.forecast_24h.map((p, j) => ({
                    ...p,
                    horizon: j + 1,
                  })) as Hour["forecast_24h"],
                }
              : h,
          ),
        }
      : data;
  const shared = predictionWindow(input, index);
  return {
    ...view,
    forecast_24h: view.forecast_24h.map((p, i) => ({
      ...p,
      realized_abstain: shared.forecast_24h[i].realized_abstain,
    })),
    reasons: Object.fromEntries(
      view.forecast_24h.map((p, i) => [
        p.t,
        data.hours[shared.forecast_24h[i].t % 24].abstain_reason,
      ]),
    ),
  };
}
function forecastReason(p: ForecastPoint): string | null {
  if (p.abstain_reason) return p.abstain_reason;
  if (!p.abstain) return null;
  if (
    Number.isFinite(p.risk_score) &&
    Number.isFinite(p.risk_threshold) &&
    p.risk_score! > p.risk_threshold!
  )
    return "风险评分超过该时域阈值";
  if (
    Number.isFinite(p.confidence_threshold) &&
    p.confidence < p.confidence_threshold!
  )
    return "置信度评分低于该时域阈值";
  return null;
}
export function confidenceThresholds(view: ForecastView): (number | null)[] {
  return view.forecast_24h.map((p) => {
    const threshold = p.confidence_threshold ?? view.confidence_threshold;
    return typeof threshold === "number" &&
      Number.isFinite(threshold) &&
      threshold >= 0 &&
      threshold <= 1
      ? threshold
      : null;
  });
}
export const primaryModelKeys = [
  "model_version",
  "retained_coverage",
  "target_coverage",
  "cross_building_coverage",
  "rejection_rate",
  "retained_mae",
  "all_sample_mae",
];
export function rejectedSlots(view: ForecastView): RejectedSlot[] {
  return view.forecast_24h
    .filter((p) => p.realized_abstain === true)
    .map((p) => ({
      t: p.t,
      end: shiftTime(p.t, 1),
      width_kw: p.upper_kw - p.lower_kw,
      reason: view.reasons[p.t] || "模型拒绝预测；具体原因暂无数据",
    }));
}
export function peakPoint(view: ForecastWindow): ForecastPoint {
  return view.forecast_24h.reduce((peak, p) =>
    p.point_kw > peak.point_kw ? p : peak,
  );
}
const labels: Record<string, string> = {
  model_version: "模型版本",
  retained_coverage: "保留样本覆盖率",
  target_coverage: "区间标称覆盖率",
  cross_building_coverage: "另一栋楼的迁移评测 · 保留样本覆盖率",
  rejection_rate: "拒绝率",
  retained_mae: "保留样本 MAE",
  all_sample_mae: "全样本 MAE",
  evaluation: "评估口径",
  cross_building_context: "跨楼宇评估说明",
  comparison_apr_dec_pooled: "4–12 月汇总对照",
  confidence_definition: "置信度定义",
  coverage_target_met: "覆盖目标达标",
  dispatch_transport: "下发通道",
  synthetic_fields: "规则生成字段",
  estimated_fields: "分配计算字段",
  holiday_feature_enabled: "节假日特征启用",
  holiday_post_route: "节假日路由",
  n: "样本数",
  retained_n: "保留样本数",
  retained_picp: "保留样本覆盖率",
  all_mae: "全样本 MAE",
  interval_score: "区间评分",
};
function cardValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "暂无数据";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "暂无数据";
    if (/coverage|picp|rejection_rate/.test(key)) return percent(value);
    return `${number(value, key === "n" || key === "retained_n" ? 0 : 1)}${/mae/.test(key) ? " kW" : ""}`;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value))
    return value.length
      ? value
          .map((v) => (typeof v === "number" ? number(v) : String(v)))
          .join("、")
      : "无";
  return String(value);
}
export function modelRows(
  card: ModelCard | null,
): { key: string; label: string; value: string }[] {
  const keys = [...new Set([...primaryModelKeys, ...Object.keys(card ?? {})])];
  return keys
    .filter((key) => key !== "device_connected")
    .flatMap((key) => {
      const value = card?.[key];
      if (
        value === null ||
        value === undefined ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length)
      )
        return [];
      if (key === "model_version" && typeof value === "string") {
        const version = value.match(/(?:^|[-_])(v\d+(?:\.\d+)*)$/i)?.[1];
        return [
          {
            key,
            label: labels[key],
            value: `负荷预测${version ? ` ${version}` : ""}${typeof card?.calibration_method === "string" && /daily/i.test(card.calibration_method) ? " · 按楼每日校准" : ""}`,
          },
        ];
      }
      // The UI interval is nominal 90%; 0.905 is the preserved calibration acceptance target, not measured coverage.
      if (key === "target_coverage" && (value === 0.905 || value === 0.9))
        return [{ key, label: labels[key], value: percent(0.9) }];
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.entries(value)
          .filter(
            ([sub, v]) =>
              sub !== "device_connected" && v !== null && v !== undefined,
          )
          .map(([sub, v]) => ({
            key: `${key}.${sub}`,
            label: `${labels[key] ?? key} · ${labels[sub] ?? sub}`,
            value: cardValue(sub, v),
          }));
      return [{ key, label: labels[key] ?? key, value: cardValue(key, value) }];
    });
}
