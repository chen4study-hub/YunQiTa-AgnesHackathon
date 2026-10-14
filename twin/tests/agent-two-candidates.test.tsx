import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { scheduleFixture } from "../e2e/agent-schedule-fixture";
import { scheduleDecision } from "../src/pages/agent/data";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
it("two candidates and missing optional economics/receipt/constraints are safe; absent required command falls back", () => {
  const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8")),
    input: any = scheduleFixture(data, 14);
  input.candidates = input.candidates.slice(0, 2);
  input.selected = input.candidates[1].candidate_id;
  input.reason = "后端理由";
  delete input.receipt;
  delete input.work_orders;
  for (const c of input.candidates) {
    delete c.simulation;
    delete c.passed;
  }
  const d = scheduleDecision(input, data, 14)!;
  expect(d).not.toBeNull();
  expect(d.candidates).toHaveLength(2);
  expect(
    d.candidates.every(
      (c) => c.cost === null && c.peak === null && c.passed === null,
    ),
  ).toBe(true);
  const html = renderToStaticMarkup(
    <DecisionCard
      data={data}
      decision={d}
      index={14}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(html).toContain("后端理由");
  expect(html).toContain("暂无数据");
  expect(scheduleDecision({ ...input, plan: null }, data, 14)).toBeNull();
  expect(scheduleDecision({ ...input, candidates: null }, data, 14)).toBeNull();
});
