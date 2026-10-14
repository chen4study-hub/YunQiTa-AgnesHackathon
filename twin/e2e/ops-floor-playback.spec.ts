import { test, expect } from "@playwright/test";
import { isolateOpsTest, opsDay } from "./ops-test-data";
import {
  opsFloorScale,
  sampleOpsFloorLoads,
} from "../src/data/ops/floorColors";
import { floorColor } from "../src/ui/floorColors";

test("3D floor colors follow fractional Ops playhead rather than hourly steps", async ({
  page,
}) => {
  await isolateOpsTest(page);
  await page.goto("/?source=file&at=2026-10-12T10:00");
  const data = opsDay("2026-10-12"),
    scale = opsFloorScale(data);
  const snapshot = async () =>
    JSON.parse(
      (await page.locator(".twin-scene").getAttribute("data-scene")) ?? "{}",
    );
  await expect
    .poll(async () => (await snapshot()).floorColorScale)
    .toEqual(scale);
  await expect
    .poll(async () => (await snapshot()).floorActualLoads)
    .toEqual(sampleOpsFloorLoads(data, data.day_start_ms + 10 * 3600000));
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  const samples: {
    opsAtMs: number;
    floorActualLoads: number[];
    floorTargetColors: string[];
  }[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(70);
    samples.push(await snapshot());
  }
  expect(new Set(samples.map((s) => s.opsAtMs)).size).toBeGreaterThan(2);
  expect(
    new Set(samples.map((s) => s.floorActualLoads.join(","))).size,
  ).toBeGreaterThan(2);
  expect(
    new Set(samples.map((s) => s.floorTargetColors.join(","))).size,
  ).toBeGreaterThan(2);
  for (const s of samples) {
    const expected = sampleOpsFloorLoads(data, s.opsAtMs);
    expect(s.floorActualLoads).toEqual(expected);
    expect(s.floorTargetColors).toEqual(
      expected.map((load, i) =>
        floorColor(load, scale, data.hours[0].floors[i].use)
          .slice(1)
          .toLowerCase(),
      ),
    );
    expect((s.opsAtMs - data.day_start_ms) % 3600000).not.toBe(0);
  }
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
});
