import { it, expect } from "vitest";
import { opsFixtureLoader } from "./ops-page-fixture";
import {
  chartHours,
  environmentChart,
  opsTimeAxis,
} from "../src/pages/energy/charts";
import { windowAlerts } from "../src/pages/energy/data";
import { opsTimeLabel } from "../src/pages/energy/time";
it("loads real adjacent calendar days instead of repeating template hour zero", async () => {
  const loader = opsFixtureLoader();
  const day = await loader.loadDay("2026-10-12");
  const start = day.day_start_ms + 22 * 3600000,
    end = day.day_start_ms + 26 * 3600000;
  const window = await loader.loadWindow(start, end);
  expect(window.days.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13"]);
  const points = chartHours(window, day.day_start_ms + 23 * 3600000);
  expect(points.map((p) => p.t)).toEqual([22, 23, 24, 25]);
  expect(opsTimeAxis(window, day.day_start_ms + 23 * 3600000)).toMatchObject({
    min: 22,
    max: 26,
  });
  expect(opsTimeAxis(window, day.day_start_ms + 25 * 3600000)).toMatchObject({
    min: -2,
    max: 2,
  });
  expect(points[2].hour).toEqual(window.days[1].data.hours[0]);
  const option = environmentChart(window, 23, day.day_start_ms + 23 * 3600000);
  expect((option.series as any[])[0].data[2][1]).toBe(
    window.days[1].data.hours[0].environment.people,
  );
  const alerts = windowAlerts(window, end);
  expect(alerts.every((a) => a.atMs >= start && a.atMs < end)).toBe(true);
  expect(
    opsTimeLabel(
      day.day_start_ms + 26 * 3600000,
      day.day_start_ms + 18 * 3600000,
    ),
  ).toBe("次日 02:00");
  expect(opsTimeLabel(day.day_start_ms - 3600000, day.day_start_ms)).toBe(
    "昨日 23:00",
  );
});
