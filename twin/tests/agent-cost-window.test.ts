import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ReplayData } from "../src/data/types";
import {
  costWindowLabel,
  replayDecision,
  scheduleDecision,
} from "../src/pages/agent/data";
import { candidateOption } from "../src/pages/agent/charts";
import { DecisionCard } from "../src/pages/agent/DecisionCard";

const data = JSON.parse(
  readFileSync("public/replay/peak.json", "utf8"),
) as ReplayData;
it("labels backend estimated_cost by the complete candidate plan, not accepted or dispatched hours", () => {
  const plan = Array.from({ length: 24 }, (_, i) => ({
    timestamp: new Date(
      Date.parse(data.hours[14].t) + i * 3_600_000,
    ).toISOString(),
    hvac_setpoint_c: 25.5,
    battery_kw: 0,
    action: i === 21 ? "human_review" : "hold",
  }));
  const response = {
    building_id: data.meta.building_id,
    plan,
    candidates: [
      {
        candidate_id: "rule_hold",
        plan,
        simulation: {
          estimated_cost: 15172.3,
          estimated_peak_kw: 1218.2,
          hours: plan.slice(0, 21),
        },
      },
    ],
    selected: "rule_hold",
    reason: "窗口选案理由。",
    work_orders: [{ timestamp: plan[21].timestamp }],
  };
  const d = scheduleDecision(response, data, 14)!;
  expect(d.costWindowHours).toBe(24);
  expect(costWindowLabel(d)).toBe("24 小时窗口合计");
  expect(d.candidates[0].cost).toBe(15172.3);
  expect(candidateOption(d).series).toMatchObject([
    { id: "candidate-cost", name: "24 小时窗口合计电费" },
  ]);
  const html = renderToStaticMarkup(
    createElement(DecisionCard, {
      decision: d,
      data,
      index: 14,
      online: true,
      pending: false,
      onAction: () => {},
    }),
  );
  expect(html).toContain("24 小时窗口合计");
  expect(d.reason).toBe(response.reason);
  expect(html).not.toContain("同一小时");
  for (const length of [1, 2]) {
    const shortened = plan.slice(0, length);
    const parsed = scheduleDecision(
      {
        ...response,
        plan: shortened,
        work_orders: [],
        candidates: [{ ...response.candidates[0], plan: shortened }],
      },
      data,
      14,
    )!;
    expect(costWindowLabel(parsed)).toBe(
      length === 1 ? "当前小时" : "2 小时窗口合计",
    );
  }
  const unknown = scheduleDecision(
    {
      ...response,
      candidates: [
        ...response.candidates,
        {
          ...response.candidates[0],
          candidate_id: "other",
          plan: plan.slice(0, 2),
        },
      ],
    },
    data,
    14,
  )!;
  expect(costWindowLabel(unknown)).toBe("调度窗口合计");
});
it("1.5 summaries use exported window; absent candidates never imply a local one-hour window", () => {
  expect(replayDecision(data, 14).costWindowHours).toBe(
    data.hours[14].agent.planning_horizon_hours,
  );
  const missing = structuredClone(data);
  delete missing.hours[14].agent.candidate_summaries;
  delete missing.hours[14].agent.planning_horizon_hours;
  expect(replayDecision(missing, 14).costWindowHours).toBeUndefined();
  expect(replayDecision(missing, 14).candidates).toEqual([]);
});
