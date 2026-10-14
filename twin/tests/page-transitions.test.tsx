import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { interpolateNumbers } from "../src/pages/energy/transitions";
import {
  INCREMENTAL_UPDATE,
  smoothOption,
  mobileReadableOption,
  energySmoothTheme,
} from "../src/pages/energy/SmoothChart";
import { emsChart, endUseChart } from "../src/pages/energy/charts";
import { opsFixtureLoader } from "./ops-page-fixture";
import type { OpsDay } from "../src/data/ops";
let day: OpsDay;
beforeAll(async () => {
  day = await opsFixtureLoader().loadDay("2026-10-12");
});

describe("page-local smooth updates", () => {
  it("interpolates numeric leaves, arrays and totals but uses target metadata", () => {
    const from = {
      value: 100,
      nested: { soc: 0.2 },
      points: [10, 20],
      status: "充电",
    };
    const to = {
      value: 200,
      nested: { soc: 0.8 },
      points: [20, 40],
      status: "放电",
    };
    expect(interpolateNumbers(from, to, 0.5)).toEqual({
      value: 150,
      nested: { soc: 0.5 },
      points: [15, 30],
      status: "放电",
    });
    expect(interpolateNumbers(from, to, 1)).toEqual(to);
    expect(interpolateNumbers(null, null, 0.5)).toBe(null);
    expect(interpolateNumbers(from, to, 2)).toEqual(to);
  });
  it("merges persistent series and enables update animation", () => {
    expect(INCREMENTAL_UPDATE.notMerge).toBe(false);
    const option = smoothOption(
      emsChart(day, 14, day.day_start_ms + 14 * 3600000),
    );
    expect(option).toMatchObject({
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 360,
    });
    const series = option.series as { id: string }[];
    expect(series.map((s) => s.id)).toEqual(["放电", "充电", "光伏"]);
    expect(
      (smoothOption(endUseChart(day.hours[14])).series as { id: string }[])[0]
        .id,
    ).toBe("分项能耗");
  });
  it("enforces plot font floors on both desktop and mobile without changing data", () => {
    const option = emsChart(day, 14, day.day_start_ms + 14 * 3600000);
    expect(mobileReadableOption(option, false).xAxis).toMatchObject({
      axisLabel: { fontSize: 12 },
    });
    const mobile = mobileReadableOption(option, true);
    const check = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(check);
      else if (node && typeof node === "object")
        for (const [key, value] of Object.entries(node)) {
          if (key === "fontSize")
            expect(Number(value)).toBeGreaterThanOrEqual(12);
          else check(value);
        }
    };
    check(mobile);
    expect((mobile.series as { data: unknown }[])[0].data).toEqual(
      (option.series as { data: unknown }[])[0].data,
    );
  });
  it("uses the computed shared note size for canvas text on desktop", () => {
    const option = emsChart(day, 14, day.day_start_ms + 14 * 3600000);
    const shared = mobileReadableOption(option, false, 12);
    expect(shared.textStyle?.fontSize).toBe(12);
    expect(shared.xAxis).toMatchObject({ axisLabel: { fontSize: 12 } });
    expect((shared.series as { data: unknown }[])[0].data).toEqual(
      (option.series as { data: unknown }[])[0].data,
    );
  });
  it("keeps rich-text tooltips at 13px and preserves intentionally larger labels", () => {
    const option = mobileReadableOption(
      {
        tooltip: { textStyle: { fontSize: 9 } },
        series: [{ type: "bar", label: { fontSize: 18 } }],
      },
      true,
      14,
    );
    expect(option.tooltip).toMatchObject({ textStyle: { fontSize: 13 } });
    expect(option.series).toMatchObject([{ label: { fontSize: 18 } }]);
    expect(energySmoothTheme.textStyle.fontSize).toBe(12);
    expect(energySmoothTheme.tooltip.textStyle.fontSize).toBe(13);
  });
  it("never uses destructive chart replacement or page keys", () => {
    for (const path of [
      "src/pages/EnergyPage.tsx",
      "src/pages/FloorsPage.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("useOpsPage");
      expect(source).not.toContain("../components/EChart");
      expect(source).not.toContain("key={state.time}");
      expect(source).not.toContain("key={state.scenario}");
    }
    const chart = readFileSync("src/pages/energy/SmoothChart.tsx", "utf8");
    expect(chart).toContain("INCREMENTAL_UPDATE");
    expect(chart).toContain("dataset.chartId");
    expect(
      readFileSync("src/pages/floors/FloorLoadChart.tsx", "utf8"),
    ).not.toContain("), true)");
  });
});
