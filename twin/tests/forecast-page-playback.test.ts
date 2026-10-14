import { it, expect } from "vitest";
import { mockReplay } from "../src/data/adapters";
import { overviewWindow } from "../src/data/overviewForecast";
import { forecastView } from "../src/pages/forecast/data";
import { playbackForecastOption } from "../src/pages/forecast/charts";
it("page adapter draws exactly the public fixed slots and gates through midnight and completion", () => {
  const data = mockReplay("normal"),
    before = structuredClone(data);
  let red: unknown;
  for (const elapsedHours of [0, 0.2, 1, 2, 3.75, 10, 24]) {
    const window = overviewWindow(data, 22.5, {
      startHour: 22.5,
      elapsedHours,
    });
    const view = forecastView(data, Math.floor(window.head) % 24);
    const option = playbackForecastOption(
      view,
      window.slots,
      data.hours[22].t,
      22,
      window.head,
    );
    const series = option.series as any[];
    expect((option.xAxis as any).min).toBe(21);
    expect((option.xAxis as any).max).toBe(46);
    expect(series.find((s) => s.id === "forecast-actual").data).toEqual(
      window.slots.map((p) => [p.t, p.actual]),
    );
    expect(series.find((s) => s.id === "forecast-future").data).toEqual(
      window.slots.map((p) => [p.t, p.point]),
    );
    const area = series.find((s) => s.id === "forecast-future").markArea.data;
    if (red) expect(area).toEqual(red);
    else red = area;
    const axis = (option.xAxis as any).axisLabel.formatter;
    expect(axis(Math.floor(window.head))).not.toMatch(/次日|昨日/);
    expect(
      series.find((s) => s.id === "forecast-actual").markLine.data,
    ).toEqual([]);
  }
  expect(data).toEqual(before);
});
