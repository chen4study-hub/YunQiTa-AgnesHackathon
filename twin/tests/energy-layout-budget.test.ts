import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { OpsDay, OpsWindow } from "../src/data/ops";
import { opsFixtureLoader } from "./ops-page-fixture";
import {
  emsChart,
  environmentChart,
  roundedAxisMax,
  temperatureAxis,
} from "../src/pages/energy/charts";
import { cumulativeUses } from "../src/pages/energy/data";
let day: OpsDay;
beforeAll(async () => {
  day = await opsFixtureLoader().loadDay("2026-10-12");
});
it("rounds full-day maxima with 10% headroom and 500-unit ticks", () => {
  expect(roundedAxisMax([3463])).toBe(4000);
  expect(roundedAxisMax([1800])).toBe(2000);
  expect(roundedAxisMax([null, 0])).toBe(500);
  const high = {
    ...day,
    hours: day.hours.map((h) => ({
      ...h,
      environment: { ...h.environment, people: 3463, co2_ppm: 1800 },
      storage: { ...h.storage, power_kw: -780 },
      pv: { ...h.pv, power_kw: 420 },
    })),
  };
  const axes = environmentChart(high, 14, day.day_start_ms).yAxis as any[];
  expect(axes.map((a) => a.max)).toEqual([4000, 2000]);
  const power = emsChart(high, 14, day.day_start_ms).yAxis as any[];
  expect(power[0].min).toBe(-900);
  expect(power[0].max).toBe(900);
  expect(power[1].max).toBe(500);
  expect(temperatureAxis([19.5, 29.6])).toEqual({ min: 19, max: 31 });
});
it("aligns environment maxima and all four axis intervals without endpoint ticks", () => {
  const crowded = {
    ...day,
    hours: day.hours.map((h) => ({
      ...h,
      environment: { ...h.environment, people: 4000, co2_ppm: 1250 },
    })),
  };
  const axes = environmentChart(crowded, 14, day.day_start_ms).yAxis as any[];
  expect(
    axes.map(({ min, max, interval }) => ({ min, max, interval })),
  ).toEqual([
    { min: 0, max: 5000, interval: 2500 },
    { min: 0, max: 2000, interval: 1000 },
  ]);
  for (const data of [day, crowded]) {
    for (const option of [
      environmentChart(data, 14, day.day_start_ms),
      emsChart(data, 14, day.day_start_ms),
    ]) {
      for (const axis of option.yAxis as any[]) {
        expect(Number.isInteger(axis.max / axis.interval)).toBe(true);
        expect(Number.isInteger(axis.min / axis.interval)).toBe(true);
        expect((axis.max - axis.min) / axis.interval).toBe(2);
      }
    }
  }
});
it("keeps bounds stable when seeking and includes adjacent window days", async () => {
  const axes = (data: OpsDay | OpsWindow, at: number) =>
    (environmentChart(data, 14, at).yAxis as any[]).map((a) => a.max);
  const expected = axes(day, day.day_start_ms);
  for (const h of [0, 14, 23])
    expect(axes(day, day.day_start_ms + h * 3600000)).toEqual(expected);
  const window = await opsFixtureLoader().loadWindow(
    day.day_start_ms + 22 * 3600000,
    day.day_start_ms + 26 * 3600000,
  );
  const people = roundedAxisMax(
    window.hours.map(({ hour }) => hour.environment.people),
    1000,
  );
  expect(axes(window, day.day_start_ms + 23 * 3600000)[0]).toBe(people);
});
it("reserves 140 drawable pixels in addition to legend and axis space", () => {
  for (const option of [
    emsChart(day, 14, day.day_start_ms),
    environmentChart(day, 14, day.day_start_ms),
  ]) {
    expect(option.grid).toMatchObject({ top: 32, bottom: 42 });
  }
  const css = readFileSync("src/pages/energy/energy.css", "utf8");
  expect(css).toContain("height: max(214px, var(--energy-plot-height))");
  expect(css).toContain("min-height: max(214px, var(--energy-plot-height))");
  expect(css).toContain(
    "/* Main owns scrolling; charts and card content grow without being clipped. */",
  );
});
it("uses four truthful cumulative cells, grouping elevator and other without dropping energy", () => {
  const raw = day.hours[14].energy.cumulative_start_kwh;
  const totals = cumulativeUses(raw);
  expect(totals).toHaveLength(4);
  expect(totals[0].energy).toBe(raw.hvac_electric_estimate_kwh);
  expect(totals[3]).toEqual({
    name: "电梯及其他",
    energy: raw.elevator_kwh + raw.other_kwh,
  });
  expect(totals.reduce((sum, item) => sum + item.energy, 0)).toBeCloseTo(
    raw.hvac_electric_estimate_kwh +
      raw.lighting_kwh +
      raw.plug_kwh +
      raw.elevator_kwh +
      raw.other_kwh,
    8,
  );
});
