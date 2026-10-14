import type { Hour, ReplayData } from "../../data/types";
import { shiftTime } from "../forecast/data";
import type { Candidate, Decision, JsonRecord, Ticket } from "./types";
import { formatPageNumber } from "../displayNumbers";
export const n = (v: number | null, digits = 1) =>
  v === null
    ? "暂无数据"
    : formatPageNumber(v, digits === 0 ? "integer" : "number");
export const pct = (v: number) => formatPageNumber(v, "percent");
export const elapsedMs = (v: number) => formatPageNumber(v, "milliseconds");
/** Positive power discharges, negative power charges. Match the displayed precision. */
export const storageMode = (v: number | null) =>
  v === null
    ? "暂无数据"
    : Math.abs(v) < 0.05
      ? "待机"
      : v > 0
        ? "放电"
        : "充电";
export const signedPower = (v: number | null) =>
  v === null
    ? "暂无数据"
    : Math.abs(v) < 0.05
      ? n(0)
      : `${v > 0 ? "+" : ""}${n(v)}`;
export const storageLabel = (v: number | null) =>
  v === null
    ? "暂无数据"
    : `${storageMode(v)} ${n(Math.abs(v) < 0.05 ? 0 : Math.abs(v))}`;
export const storagePower = (v: number | null) =>
  v === null ? "暂无数据" : `${storageLabel(v)} kW`;
export const clock = (t: string) => t.slice(11, 16);
export {
  decisionSourceLabel,
  decisionSourceTitle,
} from "../../config/decisionSource";
export function decisionReasonLabel(d: Decision): string {
  if (!d.reasonUpperWindowHours) return d.reason;
  const scope =
    d.reasonUpperWindowHours === 1
      ? "当前小时区间上界"
      : `${n(d.reasonUpperWindowHours, 0)} 小时调度窗口峰值上界`;
  return d.reason.replace(/^按(?:负荷)?区间上界/, `按${scope}`);
}

export const costWindowLabel = (d: Decision) =>
  d.costWindowHours === 1
    ? "当前小时"
    : d.costWindowHours
      ? `${d.costWindowHours} 小时窗口合计`
      : "调度窗口合计";

export const object = (v: unknown): JsonRecord =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonRecord)
    : {};
export const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const val = (v: unknown, fallback: number) => (finite(v) ? v : fallback);
const text = (v: unknown, fallback: string) =>
  typeof v === "string" && v.trim() ? v : fallback;
const texts = (v: unknown, fallback: string[]) =>
  Array.isArray(v) && v.every((s) => typeof s === "string") && v.length
    ? (v as string[])
    : fallback;

const names: Record<string, string> = {
  rule_full: "全额调度",
  rule_conservative: "保守调度",
  baseline: "保持设定",
  rule_hold: "保持设定",
  historical_full: "已执行方案",
  conservative: "保守调度",
};
/** Identifiers remain opaque transport keys; visible plan names are Chinese. */
const candidateName = (id: string, provided?: unknown) =>
  typeof provided === "string" && /[\u3400-\u9fff]/.test(provided)
    ? provided
    : (names[id] ?? "候选方案");

// Simulation estimated_cost sums accepted hourly costs across each candidate's
// full plan. Refused hours remain in the window but are excluded from economics.
function costWindowHours(input: unknown): number | undefined {
  if (!Array.isArray(input) || !input.length) return undefined;
  const windows = input.map((c) => {
    const plan = object(c).plan;
    return Array.isArray(plan)
      ? plan.map((p) => Date.parse(String(object(p).timestamp)))
      : [];
  });
  const first = windows[0];
  if (
    !first.length ||
    first.some(
      (t, i) =>
        !Number.isFinite(t) || (i > 0 && t - first[i - 1] !== 3_600_000),
    )
  )
    return undefined;
  return windows.every(
    (w) => w.length === first.length && w.every((t, i) => t === first[i]),
  )
    ? first.length
    : undefined;
}

/** The backend reason starts with max(prepared_upper_kw) over the chosen plan.
 * Qualify only verified matches; never relabel unknown/free-form numeric claims. */
function reasonUpperWindowHours(
  reason: string,
  input: unknown,
  selected: unknown,
): number | undefined {
  if (!Array.isArray(input)) return undefined;
  const candidate = input.map(object).find((c) => c.candidate_id === selected);
  if (!candidate || !Array.isArray(candidate.plan) || !candidate.plan.length)
    return undefined;
  const plan = candidate.plan.map(object);
  if (
    plan.some(
      (p, i) =>
        !finite(p.prepared_upper_kw) ||
        typeof p.timestamp !== "string" ||
        !Number.isFinite(Date.parse(p.timestamp)) ||
        (i > 0 &&
          Date.parse(String(p.timestamp)) -
            Date.parse(String(plan[i - 1].timestamp)) !==
            3_600_000),
    )
  )
    return undefined;
  const opening = reason.match(
    /^按(?:负荷)?区间上界\s+([\d,]+(?:\.\d+)?)\s*kW\s*准备/,
  );
  if (
    !opening ||
    n(Number(opening[1].replaceAll(",", ""))) !==
      n(Math.max(...plan.map((p) => p.prepared_upper_kw as number)))
  )
    return undefined;
  return plan.length;
}

/** Missing identifiers, recommendations and conservative actions stay missing. */
function ticket(raw: unknown): Ticket {
  const order = object(raw),
    defaults = object(order.conservative_default);
  return {
    id: text(order.id ?? order.work_order_id, "暂无数据"),
    reasons: texts(order.possible_reasons, ["暂无数据"]).map((s) =>
      s === "risk_score_above_threshold" ? "风险评分超过门控阈值" : s,
    ),
    checks: texts(order.suggested_checks, ["暂无数据"]),
    temp: finite(defaults.hvac_setpoint_c) ? defaults.hvac_setpoint_c : null,
    battery: finite(defaults.battery_kw) ? defaults.battery_kw : null,
  };
}
export function replayDecision(data: ReplayData, index: number): Decision {
  const hour = data.hours[index];
  const handoff =
    hour.abstain ||
    hour.agent.status === "handoff" ||
    hour.confidence < data.meta.confidence_threshold;
  const selection = object(object(hour.agent).selection_reason);
  const comparison = object(selection.current_hour_comparison);
  const stored = Array.isArray(hour.agent.candidate_summaries)
    ? hour.agent.candidate_summaries.map(object)
    : Array.isArray(comparison.candidates)
      ? comparison.candidates.map(object)
      : [];
  const recordedCandidates = stored.flatMap((c): Candidate[] => {
    if (
      typeof c.candidate_id !== "string" ||
      !finite(c.hvac_setpoint_c) ||
      !finite(c.battery_kw)
    )
      return [];
    return [
      {
        id: c.candidate_id,
        name: candidateName(c.candidate_id),
        temp: c.hvac_setpoint_c,
        battery: c.battery_kw,
        cost: finite(c.energy_cost_cny) ? c.energy_cost_cny : null,
        peak: finite(c.upper_grid_peak_kw) ? c.upper_grid_peak_kw : null,
        passed:
          typeof c.constraint_valid === "boolean" ? c.constraint_valid : null,
        basis: "规则调度器",
        peakBasis: "区间上界",
      },
    ];
  });
  const agent = object(hour.agent);
  const exportedCandidates = Array.isArray(agent.candidates)
    ? agent.candidates.map(object).flatMap((c): Candidate[] => {
        const command = Array.isArray(c.plan)
          ? c.plan
              .map(object)
              .find(
                (p) =>
                  typeof p.timestamp === "string" &&
                  Date.parse(p.timestamp) === Date.parse(hour.t),
              )
          : undefined;
        if (
          !command ||
          typeof c.candidate_id !== "string" ||
          !finite(command.hvac_setpoint_c) ||
          !finite(command.battery_kw)
        )
          return [];
        const sim = object(c.simulation);
        return [
          {
            id: c.candidate_id,
            name: candidateName(c.candidate_id, c.name),
            temp: command.hvac_setpoint_c,
            battery: command.battery_kw,
            cost: finite(sim.estimated_cost) ? sim.estimated_cost : null,
            peak: finite(sim.estimated_peak_kw) ? sim.estimated_peak_kw : null,
            passed: finite(object(c.objective_metrics).constraint_violations)
              ? object(c.objective_metrics).constraint_violations === 0
              : null,
            basis: "规则调度器",
            peakBasis: "点负荷",
          },
        ];
      })
    : [];
  const candidates = exportedCandidates.length
    ? exportedCandidates
    : recordedCandidates.length
      ? recordedCandidates
      : [];
  const receipt = object(hour.agent.receipt);
  const reason = text(agent.reason ?? hour.agent.explanation, "暂无数据");
  const selected = text(
    agent.selected ?? selection.selected_candidate_id,
    "暂无数据",
  );
  const selectedCandidate = candidates.find((c) => c.id === selected);
  return {
    t: hour.t,
    handoff,
    lifecycle: handoff ? "handoff" : "executed",
    upper: hour.upper_kw,
    confidence: hour.confidence,
    threshold: data.meta.confidence_threshold,
    temp:
      selectedCandidate?.temp ??
      (finite(hour.agent.hvac_setpoint_c) ? hour.agent.hvac_setpoint_c : null),
    battery: selectedCandidate?.battery ?? null,
    reason,
    reasonUpperWindowHours: reasonUpperWindowHours(
      reason,
      agent.candidates,
      agent.selected,
    ),
    candidates,
    costWindowHours: exportedCandidates.length
      ? costWindowHours(agent.candidates)
      : hour.agent.planning_horizon_hours,
    selected,
    source: "replay",
    selectionSource: hour.agent.source,
    explanationSource: hour.agent.explanation_source,
    grounding: typeof agent.grounded === "boolean" ? agent.grounded : null,
    receipt: {
      count: finite(receipt.count) ? receipt.count : 0,
      elapsed: finite(receipt.elapsed_ms) ? receipt.elapsed_ms : null,
      transport: text(receipt.transport, "暂无数据"),
      connected: receipt.device_connected === true,
      // Static zero is an unexecuted plan, not a current backend receipt.
      known: finite(receipt.count) && receipt.count > 0,
    },
    ticket: ticket(hour.agent.work_orders?.[0] ?? agent.ticket_summary),
  };
}
/** Reject malformed/mismatched responses rather than advertising a false receipt. */
export function scheduleDecision(
  input: unknown,
  data: ReplayData,
  index: number,
): Decision | null {
  const raw = object(input),
    hour = data.hours[index];
  if (
    raw.building_id !== data.meta.building_id ||
    !Array.isArray(raw.plan) ||
    !Array.isArray(raw.candidates)
  )
    return null;
  const command = raw.plan
    .map(object)
    .find(
      (p) =>
        typeof p.timestamp === "string" &&
        Date.parse(p.timestamp) === Date.parse(hour.t),
    );
  if (
    !command ||
    !finite(command.hvac_setpoint_c) ||
    !finite(command.battery_kw)
  )
    return null;
  const base = replayDecision(data, index);
  const candidates = raw.candidates.map(object).flatMap((c): Candidate[] => {
    const plan = Array.isArray(c.plan)
      ? c.plan
          .map(object)
          .find(
            (p) =>
              typeof p.timestamp === "string" &&
              Date.parse(p.timestamp) === Date.parse(hour.t),
          )
      : null;
    if (
      !plan ||
      typeof c.candidate_id !== "string" ||
      !finite(plan.hvac_setpoint_c) ||
      !finite(plan.battery_kw)
    )
      return [];
    const sim = object(c.simulation);
    const failures = c.constraint_failures ?? c.violations;
    const passed =
      typeof c.passed === "boolean"
        ? c.passed
        : Array.isArray(failures)
          ? failures.length === 0
          : typeof object(c.objective_metrics).constraint_violations ===
              "number"
            ? object(c.objective_metrics).constraint_violations === 0
            : null;
    return [
      {
        id: c.candidate_id,
        name: candidateName(c.candidate_id, c.name),
        temp: plan.hvac_setpoint_c,
        battery: plan.battery_kw,
        passed,
        cost: finite(sim.estimated_cost) ? sim.estimated_cost : null,
        peak: finite(sim.estimated_peak_kw) ? sim.estimated_peak_kw : null,
        basis: "接口工具",
        peakBasis: "点负荷",
      },
    ];
  });
  if (
    !candidates.length ||
    typeof raw.selected !== "string" ||
    !candidates.some((c) => c.id === raw.selected && c.passed !== false)
  )
    return null;
  if (
    candidates.length !== raw.candidates.length ||
    typeof (raw.reason ?? raw.explanation) !== "string"
  )
    return null;
  // Rolling schedules include future refused hours; only current-hour orders
  // gate the first command. Untimestamped orders remain conservative handoffs.
  const orders = Array.isArray(raw.work_orders)
    ? raw.work_orders.filter((order) => {
        const timestamp = object(order).timestamp;
        return (
          typeof timestamp !== "string" ||
          !Number.isFinite(Date.parse(timestamp)) ||
          Date.parse(timestamp) === Date.parse(hour.t)
        );
      })
    : [];
  const manual = raw.status === "manual";
  const handoff = manual
    ? false
    : raw.status === "executed"
      ? false
      : raw.status === "handoff"
        ? true
        : base.handoff ||
          raw.needs_human === true ||
          orders.length > 0 ||
          command.action === "human_review";
  if (handoff && command.battery_kw !== 0) return null;
  const receipt = object(raw.receipt);
  return {
    ...base,
    source: "schedule",
    selectionSource:
      raw.source === "llm" || raw.source === "rule" || raw.source === "mock"
        ? raw.source
        : undefined,
    explanationSource:
      raw.explanation_source === "llm" || raw.explanation_source === "template"
        ? raw.explanation_source
        : raw.explanation_source === undefined
          ? base.explanationSource
          : undefined,
    handoff,
    lifecycle: manual ? "manual" : handoff ? "handoff" : "executed",
    manualOperator:
      manual && typeof object(raw.active_takeover).operator_id === "string"
        ? String(object(raw.active_takeover).operator_id)
        : undefined,
    candidates,
    costWindowHours: costWindowHours(raw.candidates),
    selected: raw.selected,
    temp: command.hvac_setpoint_c,
    battery: command.battery_kw,
    upper: val(command.prepared_upper_kw, hour.upper_kw),
    reason: (raw.reason ?? raw.explanation) as string,
    reasonUpperWindowHours: reasonUpperWindowHours(
      (raw.reason ?? raw.explanation) as string,
      raw.candidates,
      raw.selected,
    ),
    ticket: ticket(orders[0]),
    receipt: {
      count: finite(receipt.count) ? receipt.count : 0,
      elapsed: finite(receipt.elapsed_ms) ? receipt.elapsed_ms : null,
      transport: text(receipt.transport, "暂无数据"),
      connected: receipt.device_connected === true,
      known: finite(receipt.count),
    },
  };
}
/** Window labels are timeline-relative; meter origins are retained unmodified.
 * Yesterday rows may only come from the separately loaded calendar-selected main.
 */
export function recentHours(
  data: ReplayData,
  index: number,
  previous?: ReplayData | null,
) {
  const rows: {
    t: string;
    hour: Hour;
    index: number;
    data: ReplayData;
    previous: boolean;
  }[] = [];
  for (let i = index - 5; i <= index; i++) {
    const source = i < 0 ? previous : data;
    const sourceIndex = i < 0 ? 24 + i : i;
    const hour = source?.hours[sourceIndex];
    if (!hour || !hour.agent) continue;
    rows.push({
      t: shiftTime(data.hours[index].t, i - index),
      hour,
      index: sourceIndex,
      data: source!,
      previous: i < 0,
    });
  }
  return rows;
}
