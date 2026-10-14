import { it, expect } from "vitest";
import {
  cumulativeEnergy,
  daySummary,
  tariff,
  peakTariff,
  formatNumber,
  agentVerdict,
} from "../src/data/overview";
import { mockReplay } from "../src/data/adapters";
import { readFileSync } from "node:fs";
import type { OpsDay } from "../src/data/ops/model";
it("computes cumulative energy only until cursor and daily totals", () => {
  const data = mockReplay("normal");
  expect(cumulativeEnergy(data, 0)).toBe(0);
  expect(cumulativeEnergy(data, 1)).toBe(
    (data.hours[0].actual_kw + data.hours[1].actual_kw) / 2,
  );
  expect(daySummary(data).executed + daySummary(data).handoff).toBe(24);
  expect(formatNumber(1234.5, 1)).toBe("1,234.5");
});
it("handoff preserves explanation and distinguishes generated display order", () => {
  const hour = mockReplay("abstain").hours.find(
    (h) => h.agent.status === "handoff",
  )!;
  const verdict = agentVerdict(hour, "2026-10-01", 0);
  expect(verdict.handoff).toBe(true);
  expect(verdict.explanation).toBe(hour.agent.explanation);
  expect(verdict.order).toBe("#2026-1001-01");
  expect(verdict.orderGenerated).toBe(true);
});
it("uses every exported hourly tariff including 1.20 peak, without local fallback", () => {
  const data = mockReplay("normal");
  const ops = JSON.parse(
    readFileSync(
      new URL("../../exports/replay/normal.ops.json", import.meta.url),
      "utf8",
    ),
  ) as OpsDay;
  const schedule = ops.meta.tariff;
  expect(peakTariff(schedule)).toBe(1.2);
  for (let h = 0; h < 24; h++)
    expect(tariff(h, schedule)).toBe(schedule.prices[h]);
  expect(daySummary(data, schedule).estimatedCost).toBe(
    data.hours.reduce((sum, h, i) => sum + h.point_kw * schedule.prices[i], 0),
  );
  expect(daySummary(data).estimatedCost).toBeNull();
  expect(peakTariff(null)).toBeNull();
  expect(tariff(24, schedule)).toBeNull();
  expect(tariff(0.5, schedule)).toBeNull();
  const changed = { ...schedule, prices: schedule.prices.map((p) => p * 2) };
  expect(daySummary(data, changed).estimatedCost).toBeCloseTo(
    daySummary(data, schedule).estimatedCost! * 2,
  );
  expect(peakTariff(changed)).toBe(2.4);
});
