import { describe, expect, it } from "vitest";
import {
  floorLabelStride,
  floorLoadOption,
} from "../src/pages/floors/FloorLoadChart";

describe("viewport-sized floor load bars", () => {
  it("formats bar labels with exactly one decimal without changing loads", () => {
    const loads = [33, 28, 29.2, 1234];
    const option = floorLoadOption(loads, 1, 360, {
      p10: 28,
      p50: 33,
      p90: 100,
    });
    const series = (option.series as any[])[0];
    expect(loads.map((value) => series.label.formatter({ value }))).toEqual([
      "33.0",
      "28.0",
      "29.2",
      "1,234.0",
    ]);
    expect(series.data.map((row: any) => row.value)).toEqual(loads);
  });
  it("spaces narrow x-axis ticks by at least ten kW and keeps the unit", () => {
    const option = floorLoadOption([0, 5, 20, 34.5], 1, 360, {
      p10: 5,
      p50: 20,
      p90: 30,
    });
    expect(option.xAxis).toMatchObject({
      min: 0,
      max: 40,
      interval: 10,
      name: "kW",
      nameGap: 10,
    });
    expect((option.xAxis as any).axisLabel.formatter(1000)).toBe("1,000");
  });
  it("retains all 40 values and samples labels without shrinking typography", () => {
    const loads = Array.from({ length: 40 }, (_, i) => 1200.25 + i);
    for (const height of [345, 356, 647]) {
      const option = floorLoadOption(
        loads,
        22,
        height,
        { p10: 1205, p50: 1220, p90: 1235 },
        [],
        12,
      );
      const series = (option.series as any[])[0];
      expect(series.data.map((row: any) => row.value)).toEqual(loads);
      expect(series.data[21].label.show).toBe(true);
      expect(series.label.fontSize).toBe(12);
      expect(series.label.formatter({ value: 1234.25 })).toBe("1,234.3");
      const stride = floorLabelStride(40, height, 12);
      expect(stride).toBe(height < 600 ? 2 : 1);
      const visible = series.data.flatMap((row: any, index: number) =>
        row.label.show ? [index] : [],
      );
      for (let i = 1; i < visible.length; i++)
        expect(visible[i] - visible[i - 1]).toBeGreaterThanOrEqual(stride);
      expect((option.tooltip as any).trigger).toBe("item");
      expect(
        (option.tooltip as any).formatter({
          seriesName: "楼层负荷",
          name: "22F",
          value: 1234.25,
        }),
      ).toContain("1,234.3 kW");
    }
  });
});
