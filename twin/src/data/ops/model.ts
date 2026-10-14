// Ops-local contracts; deliberately independent of src/data/types.ts.
export type OpsScenario = "normal" | "peak" | "abstain";
export interface OpsCalendarDay {
  date: string;
  scenario: OpsScenario;
  source_date: string;
  day_start_ms: number;
}
export interface OpsCalendar {
  schema_version: "1.0";
  kind: "calendar";
  timezone: string;
  rule_version: string;
  policy: Record<string, string>;
  calendar_reference: string;
  days: OpsCalendarDay[];
}
export interface OpsMotionMeta {
  floor_height_m: number;
  max_speed_m_s: number;
  acceleration_m_s2: number;
  motion: "trapezoidal_acceleration";
}
export interface OpsMeta extends OpsMotionMeta {
  scenario: OpsScenario;
  source_date: string;
  building_id: string;
  timezone: string;
  source_timezone: string;
  source_sha256: string;
  generator_version: string;
  config_sha256: string;
  provider: string;
  floors: number;
  zones: string[];
  floors_file?: string;
  floors_sha256?: string;
  tariff: {
    currency: "CNY";
    unit: "CNY/kWh";
    definition: string;
    periods: ("valley" | "flat" | "peak")[];
    prices: number[];
  };
  rules: {
    id: string;
    threshold: number;
    unit: string;
    system: string;
    content: string;
    checks: string[];
  }[];
  precision: Record<string, number>;
  units: Record<string, string>;
  connections: { system: string; connected: boolean; provider: string }[];
}
export interface OpsFloor {
  floor: number;
  use: "lobby" | "office" | "garden" | "equipment";
  floor_kw: number;
  floor_actual_kw: number;
  occupancy_people: number;
  lighting_pct: number;
  fresh_air_m3_h: number;
  co2_ppm: number;
  fan_pct: number;
  mean_temp_c: number;
  zones: { id: string; temp_c: number; fan_pct: number }[];
}
export interface OpsEnergyTotals {
  actual_kwh: number;
  hvac_electric_estimate_kwh: number;
  lighting_kwh: number;
  plug_kwh: number;
  elevator_kwh: number;
  other_kwh: number;
}
export interface OpsHour {
  offset_ms: number;
  source_t: string;
  actual_kw: number;
  point_kw: number | null;
  outdoor_temp_c: number;
  hvac_setpoint_c: number;
  solar_w_m2: number;
  floors: OpsFloor[];
  environment: {
    people: number;
    co2_ppm: number;
    indoor_temp_c: number;
    outdoor_temp_c: number;
    relative_humidity_pct: number;
    pm25_ug_m3: number;
    humidity_basis: string;
  };
  end_uses: {
    hvac_electric_estimate_kw: number;
    lighting_kw: number;
    plug_kw: number;
    elevator_kw: number;
    other_kw: number;
  };
  energy: {
    hour_kwh: OpsEnergyTotals;
    cumulative_start_kwh: OpsEnergyTotals;
    cumulative_end_kwh: OpsEnergyTotals;
    hour_cost_cny: number;
  };
  storage: { power_kw: number | null; soc: number | null };
  pv: { power_kw: number | null };
  grid_kw: number | null;
  quality: Record<string, string>;
}
export interface OpsTrip {
  depart_ms: number;
  from_floor: number;
  to_floor: number;
  arrive_ms: number;
  dwell_ms: number;
  load_pct: number;
  passengers: number;
}
export interface OpsElevator {
  id: string;
  zone: string;
  stops: number[];
  initial_floor: number;
  capacity_people: number;
  seed_sha256: string;
  trips: OpsTrip[];
}
export interface OpsWorkOrder {
  id: string;
  alert_id: string;
  offset_ms: number;
  system: string;
  content: string;
  suggested_checks: string[];
  status: string;
  resolved_offset_ms: number | null;
}
export interface OpsAlert extends Omit<OpsWorkOrder, "alert_id"> {
  rule_id: string;
  level: string;
  asset_id: string;
  work_order_id: string;
}
export interface OpsAgentRef {
  id: string;
  offset_ms: number;
  source_t: string;
  detail_index: number;
  suggested_checks: string[];
}
export interface OpsDay {
  schema_version: "1.0";
  kind: "day";
  day_start_ms: number;
  meta: OpsMeta;
  hours: OpsHour[];
  elevators: OpsElevator[];
  alerts: OpsAlert[];
  work_orders: OpsWorkOrder[];
  agent_order_refs: OpsAgentRef[];
  history: {
    hours: OpsHour[];
    source_date: string;
    source_sha256: Record<string, string>;
    agent_records: unknown[];
    agent_records_quality: string;
  };
  summary: { energy_kwh: OpsEnergyTotals; cost_cny: number };
}
export interface OpsFloorsFile {
  schema_version: "1.0";
  kind: "floors";
  scenario: OpsScenario;
  source_date: string;
  hours: { offset_ms: number; floors: OpsFloor[] }[];
  history: { offset_ms: number; floors: OpsFloor[] }[];
}
export interface OpsElevatorState {
  id: string;
  floor: number;
  target: number;
  status: "up" | "down" | "doors" | "idle";
  direction: -1 | 0 | 1;
  load_pct: number;
}
export const OPS_DAY_MS = 86_400_000;
export const OPS_HOUR_MS = 3_600_000;
export type OpsFetch = (url: string, init?: RequestInit) => Promise<Response>;
