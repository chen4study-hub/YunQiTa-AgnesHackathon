// Page-local contract 1.2 boundary. Shared replay/store remain untouched.
export interface ForecastPoint {
  t: string;
  point_kw: number;
  lower_kw: number;
  upper_kw: number;
  confidence: number;
  abstain: boolean;
  /** Canonical target-hour gate supplied by data/forecast.predictionWindow. */
  realized_abstain?: boolean;
  confidence_threshold?: number;
  abstain_reason?: string | null;
  risk_score?: number;
  risk_threshold?: number;
}
export interface ActualPoint {
  t: string;
  actual_kw: number;
}
/** Each hourly record contains exactly 24 future points and two observations. */
export interface ForecastWindow {
  forecast_24h: readonly ForecastPoint[];
  recent_actual: readonly ActualPoint[];
}
export interface ForecastView extends ForecastWindow {
  current_t: string;
  source: "contract-1.2" | "mock";
  note: string;
  confidence_threshold?: number;
  reasons: Readonly<Record<string, string | null>>;
}
export interface RejectedSlot {
  t: string;
  end: string;
  width_kw: number;
  reason: string;
}
