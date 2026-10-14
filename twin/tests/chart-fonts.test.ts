import { expect, it } from "vitest";
import { darkTheme } from "../src/ui/chartTheme";
import { sampleChart } from "../src/ui/sampleChart";
import { overviewForecastOption } from "../src/components/ReplayChart";
import { mockReplay } from "../src/data/adapters";

it("keeps yunqi-dark axes, legends and annotations readable, with 13px tooltip body", () => {
  expect(darkTheme.textStyle.fontSize).toBeGreaterThanOrEqual(12);
  for (const axis of [
    "categoryAxis",
    "valueAxis",
    "timeAxis",
    "logAxis",
  ] as const) {
    expect(darkTheme[axis].axisLabel.fontSize).toBeGreaterThanOrEqual(12);
    expect(darkTheme[axis].nameTextStyle.fontSize).toBeGreaterThanOrEqual(12);
  }
  expect(darkTheme.legend.textStyle.fontSize).toBeGreaterThanOrEqual(12);
  expect(darkTheme.axisPointer.label.fontSize).toBeGreaterThanOrEqual(12);
  expect(darkTheme.tooltip.textStyle.fontSize).toBe(13);
  for (const marker of ["markLine", "markPoint", "markArea"] as const) {
    expect(darkTheme[marker].label.fontSize).toBeGreaterThanOrEqual(12);
    expect(darkTheme[marker].emphasis.label.fontSize).toBeGreaterThanOrEqual(
      12,
    );
  }
});

it("does not override the theme with smaller overview or showcase fonts", () => {
  const option = overviewForecastOption(mockReplay("normal"), 14);
  expect(option.legend).toMatchObject({ textStyle: { fontSize: 12 } });
  expect(option.xAxis).toMatchObject({
    axisLabel: {
      fontSize: 12,
      interval: 7,
      showMaxLabel: true,
      hideOverlap: true,
    },
  });
  expect(option.yAxis).toMatchObject({ axisLabel: { fontSize: 12 } });
  expect(sampleChart.yAxis).toMatchObject({ nameTextStyle: { fontSize: 12 } });
});
