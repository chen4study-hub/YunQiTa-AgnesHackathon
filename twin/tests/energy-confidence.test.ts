import { expect, it } from "vitest";
import { opsFixtureLoader } from "./ops-page-fixture";
import { energyAlerts } from "../src/pages/energy/data";
it("preserves backend work-order content, including confidence and source IDs", async () => {
  const loader = opsFixtureLoader();
  const day = await loader.loadDay("2026-10-11");
  const before = JSON.stringify(day);
  const rows = energyAlerts(day, day.day_start_ms + 23 * 3600000);
  for (const row of rows) {
    const raw = [...day.alerts, ...day.work_orders].find(
      (r) => r.id === row.id,
    )!;
    expect(row.content).toBe(raw.content);
  }
  expect(JSON.stringify(day)).toBe(before);
});
