import type { ReplayData } from "./types";
export interface ForecastPoint {
  t: number;
  point_kw: number;
  lower_kw: number;
  upper_kw: number;
  abstain: boolean;
  /** Target-hour gate in the same cyclic dataset, independent of forecast origin. */
  realized_abstain: boolean;
}
export interface PredictionWindow {
  generated_at: number;
  source: "contract" | "mock";
  recent_actual: { t: number; actual_kw: number | null }[];
  forecast_24h: ForecastPoint[];
}
/** Select the latest completed origin; contract forecasts never read future actuals. */
export function predictionWindow(
  data: ReplayData,
  time: number,
): PredictionWindow {
  const origin = Math.max(0, Math.min(23, Math.floor(time)));
  const now = data.hours[origin];
  return {
    generated_at: origin,
    source: data.meta.model_version.startsWith('mock-') ? 'mock' : 'contract',
    recent_actual: now.recent_actual.map((p, i) => ({ t: origin + i - 1, actual_kw: p.actual_kw })), 
    forecast_24h: now.forecast_24h.map((p) => {
      return {
        t: origin + p.horizon,
        point_kw: p.point_kw,
        lower_kw: p.lower_kw,
        upper_kw: p.upper_kw,
        abstain: p.abstain,
        realized_abstain: data.hours[((origin + p.horizon) % 24 + 24) % 24].abstain,
      };
    }),
  };
}
