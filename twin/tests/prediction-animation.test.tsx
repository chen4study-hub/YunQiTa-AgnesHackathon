import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ECharts } from "echarts";
import {
  AnimatedNumberText,
  interpolateNumberText,
} from "../src/components/AnimatedNumberText";
import { updateChart, chartPresentation } from "../src/components/chartUpdate";
import { overviewForecastOption } from "../src/components/ReplayChart";
import { mockReplay } from "../src/data/adapters";
it("tweens ranges with grouping/precision, ends exactly and refuses changed units", () => {
  expect(
    interpolateNumberText("1,000.0 – 2,000.0 kW", "2,000.0 – 4,000.0 kW", 0),
  ).toBe("1,000.0 – 2,000.0 kW");
  expect(
    interpolateNumberText("1,000.0 – 2,000.0 kW", "2,000.0 – 4,000.0 kW", 0.5),
  ).toBe("1,875.0 – 3,750.0 kW");
  expect(interpolateNumberText("1.0", "5.0", 1)).toBe("5.0");
  expect(interpolateNumberText("10 kW", "12 kWh", 0.5)).toBe("12 kWh");
  expect(renderToStaticMarkup(<AnimatedNumberText text="1,200.0" />)).toContain(
    'aria-label="1,200.0"',
  );
});
it("updates the same chart with merging and preserves tooltip formatter and requested animation", () => {
  const formatter = () => "original";
  const setOption = vi.fn();
  updateChart(
    { setOption } as unknown as ECharts,
    { animation: true, tooltip: { formatter } },
    false,
  );
  expect(setOption).toHaveBeenCalledWith(
    expect.objectContaining({
      animation: true,
      tooltip: expect.objectContaining({ formatter, renderMode: "richText" }),
    }),
    { notMerge: false, lazyUpdate: true },
  );
  expect(chartPresentation({ animation: true }, true).animation).toBe(false);
});
it("retains stable overview series ids and update animation across time/scenario changes", () => {
  const a = overviewForecastOption(mockReplay("normal"), 10),
    b = overviewForecastOption(mockReplay("abstain"), 14);
  const ids = (o: typeof a) => (o.series as { id: string }[]).map((s) => s.id);
  expect(ids(a)).toEqual(ids(b));
  expect(new Set(ids(a)).size).toBe(5);
  expect(a.animation).toBe(true);
  expect(a.animationDurationUpdate).toBe(280);
});
