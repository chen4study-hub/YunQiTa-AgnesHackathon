import { test, expect } from "@playwright/test";
import { evaluateOpsSnapshot } from "../src/data/ops/elevator";
import { opsDay, isolateOpsTest } from "./ops-test-data";

test.beforeEach(async ({ page }) => isolateOpsTest(page));
test("Ops high lifts cross low floors above visible no-stop masks and only stop at exported stops", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const day = opsDay("2026-10-12"),
    high = day.elevators.filter((lift) => lift.zone === "high");
  expect(high.length).toBeGreaterThan(0);
  // Absolute offsets must be added to the selected calendar day's start, never
  // passed as Unix timestamps or an animation-relative elapsed time.
  const crossings: { id: string; offset: number; floor: number }[] = [];
  for (const lift of high)
    for (const trip of lift.trips) {
      for (const offset of [
        trip.depart_ms,
        (trip.depart_ms + trip.arrive_ms) / 2,
        trip.arrive_ms,
        trip.arrive_ms + trip.dwell_ms - 1,
      ]) {
        const state = evaluateOpsSnapshot(
          day,
          day.day_start_ms + offset,
        ).elevators.find((row) => row.id === lift.id)!;
        if (state.status === "doors" || state.status === "idle")
          expect(lift.stops).toContain(state.floor);
        else if (state.floor >= 2 && state.floor <= 20)
          crossings.push({ id: lift.id, offset, floor: state.floor });
      }
    }
  expect(crossings.length).toBeGreaterThan(0);
  // Sample a real exported crossing at a whole-second timestamp.
  const sample = crossings[0],
    at = day.day_start_ms + Math.floor(sample.offset / 1000) * 1000;
  const d = new Date(at),
    time = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((v) => String(v).padStart(2, "0"))
      .join(":");
  await page.goto(`/?source=file&at=2026-10-12T${time}`);
  await page.getByRole("button", { name: "楼层与电梯" }).click();
  await expect(page.locator(".floors-lift-column")).toHaveCount(
    day.elevators.length,
  );
  for (const lift of high) {
    // Identify the exported ID, not a legacy high-zone CSS class.
    const column = page
      .locator(".floors-lift-column")
      .filter({
        has: page
          .locator("h3")
          .filter({ hasText: new RegExp(`^${lift.id}高区$`) }),
      });
    await expect(column).toHaveCount(1);
    const mask = column.locator(".floors-unserved");
    await expect(
      mask,
      "High-zone low-floor mask is a product requirement",
    ).toBeVisible();
    await expect(mask).toHaveAttribute("aria-label", "2至20F不停靠，仅穿越");
    const state = evaluateOpsSnapshot(day, at).elevators.find(
      (row) => row.id === lift.id,
    )!;
    await expect
      .poll(async () =>
        Math.abs(
          Number(
            await column
              .locator(".floors-lift-shaft")
              .getAttribute("data-floor"),
          ) - state.floor,
        ),
      )
      .toBeLessThanOrEqual(0.05);
    const geometry = await column
      .locator(".floors-lift-shaft")
      .evaluate((shaft) => {
        const mask = shaft.querySelector<HTMLElement>(".floors-unserved")!,
          car = shaft.querySelector<HTMLElement>(".floors-lift-car")!;
        const s = shaft.getBoundingClientRect(),
          m = mask.getBoundingClientRect();
        const h = shaft.clientHeight,
          carH = car.getBoundingClientRect().height;
        return {
          height: m.height,
          bottom: s.bottom - m.bottom,
          top: s.bottom - m.top,
          expectedBottom: (h - carH) / 39,
          expectedTop: ((h - carH) * 20) / 39,
          carZ: Number(getComputedStyle(car).zIndex),
          maskZ: Number(getComputedStyle(mask).zIndex),
          background: getComputedStyle(mask).backgroundImage,
        };
      });
    console.log("OPS_HIGH_MASK", lift.id, JSON.stringify(geometry));
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.bottom).toBeCloseTo(geometry.expectedBottom, 0);
    expect(geometry.top).toBeCloseTo(geometry.expectedTop, 0);
    expect(geometry.carZ).toBeGreaterThan(geometry.maskZ);
    expect(geometry.background).not.toBe("none");
  }
});
