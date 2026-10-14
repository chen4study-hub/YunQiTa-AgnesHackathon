import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import {
  replayDecision,
  scheduleDecision,
  decisionReasonLabel,
  decisionSourceTitle,
} from "../src/pages/agent/data";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
const data = () =>
  JSON.parse(readFileSync("public/replay/normal.json", "utf8")) as ReplayData;
it("current-hour upper and full-plan maximum are explicitly scoped without mutating source reason/numbers", () => {
  const d = data(),
    h = d.hours[14],
    decision = replayDecision(d, 14),
    before = structuredClone(decision);
  expect(decision.upper).toBe(h.upper_kw);
  expect(decision.reason).toBe(h.agent.explanation);
  expect(decision.reasonUpperWindowHours).toBeUndefined();
  expect(decisionReasonLabel(decision)).toBe(h.agent.explanation);
  const html = renderToStaticMarkup(
    <DecisionCard
      decision={decision}
      data={d}
      index={14}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(html).toContain("当前小时区间上界");
  expect(html).toContain(
    h.upper_kw.toLocaleString("en-US", { maximumFractionDigits: 1 }),
  );
  expect(html).toContain("调度理由");
  expect(html.replace(/<[^>]*>/g, "")).not.toContain("模板措辞");
  expect(html).toContain(`title="${decisionSourceTitle(decision)}"`);
  expect(decision).toEqual(before);
});
it("remote reasons are qualified only against their own full plan, unknown/mismatched reasons remain intact", () => {
  const d = data(),
    h = d.hours[14];
  const plan = [
    {
      timestamp: h.t,
      hvac_setpoint_c: 25.5,
      battery_kw: 0,
      action: "hold",
      prepared_upper_kw: 1282.2,
    },
  ];
  const response = {
    building_id: d.meta.building_id,
    source: "rule",
    plan,
    candidates: [{ candidate_id: "rule_hold", plan }],
    selected: "rule_hold",
    reason: "按区间上界 1,282.2 kW准备。理由。",
    explanation_source: "template",
  };
  const decision = scheduleDecision(response, d, 14)!;
  expect(decision.reasonUpperWindowHours).toBe(1);
  expect(decisionReasonLabel(decision)).toBe(
    "按当前小时区间上界 1,282.2 kW准备。理由。",
  );
  for (const reason of ["按区间上界 1,348.7 kW准备。", "接口原文"]) {
    const other = scheduleDecision({ ...response, reason }, d, 14)!;
    expect(other.reasonUpperWindowHours).toBeUndefined();
    expect(decisionReasonLabel(other)).toBe(reason);
  }
  expect(response.reason).toBe("按区间上界 1,282.2 kW准备。理由。");
});
