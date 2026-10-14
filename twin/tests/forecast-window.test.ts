import { it, expect } from "vitest";
import { mockReplay } from "../src/data/adapters";
import { predictionWindow } from "../src/data/forecast";
import { overviewForecastOption } from "../src/components/ReplayChart";
it("rolling window is 2 actual +24 forecast with intervals and no future actual leakage", () => {
  const data = mockReplay("normal");
  const window = predictionWindow(data, 14.5);
  expect(window.recent_actual.map((p) => p.t)).toEqual([13, 14]);
  expect(window.forecast_24h).toHaveLength(24);
  expect(window.forecast_24h[0].t).toBe(15);
  expect(window.forecast_24h.at(-1)!.t).toBe(38);
  data.hours.slice(16).forEach((h) => (h.actual_kw = 999999));
  expect(predictionWindow(data, 14.5)).toEqual(window);
  expect(window.forecast_24h.map(p => p.point_kw)).toEqual(data.hours[14].forecast_24h.map(p => p.point_kw));
  expect(
    window.forecast_24h.every(
      (p) => p.lower_kw <= p.point_kw && p.upper_kw >= p.point_kw,
    ),
  ).toBe(true);
});
it("small chart has readable padded axis, aligned band and cross-midnight labels", () => {
  const data = mockReplay("normal");
  const window = predictionWindow(data, 22);
  const option = overviewForecastOption(data, 22);
  const y = option.yAxis as { min: number; max: number };
  expect(y.min).toBeGreaterThan(0);
  expect(y.min).toBeLessThan(
    Math.min(...window.forecast_24h.map((p) => p.lower_kw)),
  );
  expect(y.max).toBeGreaterThan(
    Math.max(...window.forecast_24h.map((p) => p.upper_kw)),
  );
  const series = option.series as { data: (number | null)[] }[];
  const endpoint = window.recent_actual[1].actual_kw;
  expect(series[0].data.slice(0, 2)).toEqual([null, endpoint]);
  expect(series[1].data.slice(0, 2)).toEqual([null, 0]);
  expect(series[2].data.slice(0, 2)).toEqual([null, endpoint]);
  expect(series[4].data[1]).toBe(endpoint);
  expect((option.series as { lineStyle?: { color?: string } }[])[2].lineStyle?.color).not.toBe((option.series as { lineStyle?: { color?: string } }[])[4].lineStyle?.color);
  window.forecast_24h.forEach((point, i) => {
    expect(
      Number(series[0].data[i + 2]) + Number(series[1].data[i + 2]),
    ).toBeCloseTo(point.upper_kw, 8);
    expect(series[2].data[i + 2]).toBe(point.point_kw);
  });
  const x = option.xAxis as {
    data: string[];
    axisLabel: { formatter: (value: string) => string };
  };
  expect(x.data).toHaveLength(26);
  expect(x.axisLabel.formatter("24")).toBe("次日 00:00");
  expect(x.axisLabel.formatter("23")).toBe("23:00");
});
