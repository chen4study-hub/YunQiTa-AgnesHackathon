import { it, expect } from "vitest";
import { mockReplay } from "../src/data/adapters";
import { predictionWindow } from "../src/data/forecast";
import { forecastView, rejectedSlots } from "../src/pages/forecast/data";
import { forecastOption, confidenceOption } from "../src/pages/forecast/charts";
it("page red regions, counts and confidence colors use the public target-hour gate without altering confidence or origin flags", () => {
  const data = mockReplay("normal");
  data.hours.forEach((h, i) => {
    h.abstain = i % 3 === 0;
    h.forecast_24h.forEach((p) => (p.abstain = i % 2 === 0));
  });
  const before = structuredClone(data);
  for (const origin of [0, 14, 22, 23]) {
    const view = forecastView(data, origin),
      shared = predictionWindow(data, origin);
    expect(view.forecast_24h.map((p) => p.realized_abstain)).toEqual(
      shared.forecast_24h.map((p) => p.realized_abstain),
    );
    expect(view.forecast_24h.map((p) => p.abstain)).toEqual(
      data.hours[origin].forecast_24h.map((p) => p.abstain),
    );
    expect(view.forecast_24h.map((p) => p.confidence)).toEqual(
      data.hours[origin].forecast_24h.map((p) => p.confidence),
    );
    const expected = shared.forecast_24h.filter(
      (p) => p.realized_abstain,
    ).length;
    expect(rejectedSlots(view)).toHaveLength(expected);
    const forecast = forecastOption(view).series as any[];
    expect(
      forecast.find((s) => s.id === "forecast-future").markArea.data,
    ).toHaveLength(expected);
    const confidence = confidenceOption(view).series as any[];
    expect(
      confidence[0].data.filter((p: any) => p.itemStyle.color === "#ff8493"),
    ).toHaveLength(expected);
  }
  expect(data).toEqual(before);
});
