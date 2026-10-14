export interface ThermalReading {
  raw_kwh: number | null;
  effective_kwh: number | null;
  source_wall_time: string | null;
  age_hours: number | null;
}
export interface HvacEvidence {
  season: "cooling" | "heating" | "shoulder";
  thermal_kw: number | null;
  uncapped_electric_estimate_kw: number | null;
  cap_applied: boolean;
  effective_readings: { chilledwater: ThermalReading; steam: ThermalReading };
  quality: "observed" | "past_fill" | "missing";
  basis: "current_or_past_meter" | "persistence_at_origin";
  origin: string | null;
}
/** Optional in 1.2, required and strictly validated by the 1.3/1.4 runtime schemas. */
export interface ThermalFields {
  hvac?: HvacEvidence;
  hvac_electric_estimate_kw?: number | null;
  hvac_electric_estimated_share?: number | null;
  floors_hvac_electric_estimate_kw?: number[] | null;
  floors_non_hvac_estimate_kw?: number[] | null;
}
export interface EnergySummary {
  hvac_electric_estimate_kwh: number | null;
  matched_building_electric_kwh: number | null;
  hvac_electric_estimated_share: number | null;
  valid_hours: number;
  total_hours: 24;
  cap_applied_hours: number;
  past_fill_hours: number;
  denominator: string;
  label: string;
}
export interface ForecastHour extends ThermalFields {
  t: string;
  horizon: number;
  point_kw: number;
  lower_kw: number;
  upper_kw: number;
  confidence: number;
  abstain: boolean;
  risk_score: number;
  risk_threshold: number;
  confidence_threshold: number;
  floors_kw: number[];
}
export interface RecentActual {
  t: string;
  actual_kw: number;
}
export interface Hour extends ThermalFields {
  t: string;
  actual_kw: number;
  point_kw: number;
  lower_kw: number;
  upper_kw: number;
  confidence: number;
  risk_score: number;
  risk_threshold: number;
  abstain: boolean;
  abstain_reason: string | null;
  outdoor_temp_c: number | null;
  floors_kw: number[];
  forecast_24h: ForecastHour[];
  recent_actual: RecentActual[];
  storage: { power_kw: number; soc: number };
  pv: { power_kw: number };
  grid_kw: number;
  agent: {
    status: "executed" | "handoff";
    source: "llm" | "rule" | "mock";
    hvac_setpoint_c: number;
    actions: string[];
    explanation: string;
    /** Wording provenance; independent of the candidate-selection source. */
    explanation_source?: "llm" | "template";
    work_orders?: Record<string, unknown>[];
    receipt?: Record<string, unknown>;
    selection_reason?: Record<string, unknown>;
    selected?: string | null;
    detail_index?: number;
    planning_horizon_hours?: number;
    candidate_summaries?: CandidateSummary[];
    candidates?: Record<string, unknown>[];
  };
}
export interface Campus {
  building_id: string;
  primary_use: string;
  sqm: number | null;
  hourly: { point_kw: number | null; abstain: boolean }[];
}
export interface ReplayData {
  schema_version: "1.2" | "1.3" | "1.4" | "1.5";
  energy_summary?: EnergySummary;
  meta: {
    scenario: string;
    title: string;
    date: string;
    building_id: string;
    display_name: string;
    sqm: number;
    floors: number;
    floors_source: "estimated_from_area";
    floor_uses: ("lobby" | "office" | "garden" | "equipment")[];
    alpha: number;
    model_version: string;
    multi_horizon_model_version: string;
    forecast_weather: "persistence_at_origin";
    operating_point: string;
    mode: "auto";
    confidence_threshold: number;
    data_source: DataSource;
    units: { power: "kW"; temperature: "°C" };
    simulated_fields: string[];
    estimated_fields: string[];
    hvac_method?: Record<string, unknown>;
    thermal_sources?: Record<string, unknown>;
    agent_detail_file?: string;
  };
  hours: Hour[];
  campus: Campus[];
}
export interface DataSource {
  name: string;
  attribution: string;
  url: string;
  license: "CC BY-SA 4.0";
  modifications: string;
}
export interface ModelCard {
  model_version: string;
  retained_coverage: number | null;
  target_coverage: number;
  cross_building_coverage: number | null;
  rejection_rate: number | null;
  retained_mae: number | null;
  [key: string]: unknown;
}
export interface ScenarioInfo {
  id: string;
  title: string;
}
export interface CandidateSummary {
  candidate_id: string;
  hvac_setpoint_c: number;
  battery_kw: number;
  energy_cost_cny: number | null;
  point_grid_peak_kw: number | null;
  upper_grid_peak_kw: number | null;
  constraint_valid: boolean;
  accepted_hours: number;
  excluded_hours: number;
}
export interface AgentDetailHour {
  t: string;
  agent: Hour["agent"];
  runtime_evidence: Record<string, unknown>;
}
export interface AgentDetail {
  schema_version: "1.5";
  scenario: string;
  building_id: string;
  main_sha256: string;
  origin_metadata: Record<string, unknown>;
  hours: Record<string, AgentDetailHour>;
}
export interface TwinDataSource {
  listScenarios(): Promise<ScenarioInfo[]>;
  loadScenario(id: string): Promise<ReplayData>;
  loadModelCard(): Promise<ModelCard>;
  /** Only fetched when the user requests Agent evidence, never for initial main data. */
  loadAgentDetail?(
    data: ReplayData,
    hourIndex: number,
  ): Promise<AgentDetailHour>;
}
export interface BuildingSpec {
  floors: number;
  sqm: number;
  twistDeg: number;
  baseWidth: number;
  topWidth: number;
  taperExponent: number;
  gardenFloors: number[];
}
export interface TwinFrame {
  hour: Hour;
  campus: { point_kw: number | null; abstain: boolean }[];
  hourIndex: number;
}

export { validateReplay } from "./validate";
