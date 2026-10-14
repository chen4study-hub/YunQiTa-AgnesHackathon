import { expect, test } from "@playwright/test";
import { opsDay, OPS_DATES, isolateOpsTest } from "./ops-test-data";
import { opsFloorScale as dailyFloorScale } from "../src/pages/floors/metrics";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
import { EQUIPMENT_COLOR, floorColor } from "../src/ui/floorColors";

for (const scenario of ["normal", "peak", "abstain"] as const)
  test(`updated model export retains differentiated office colors: ${scenario}`, async ({
    page,
  }) => {
    const date = OPS_DATES[scenario],
      data = opsDay(date);
    await page.goto(`/?source=file&at=${date}T14:00`);
    await expect(page.locator(".bottombar")).toBeVisible();
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    const scale = dailyFloorScale(data);
    await expect(page.locator(".floors-load-chart")).toHaveAttribute(
      "data-color-scale",
      JSON.stringify(scale),
    );
    const colors = data.hours[14].floors.map((row) =>
      floorColor(row.floor_actual_kw, scale, row.use),
    );
    expect(
      new Set(
        colors.filter((_, i) => data.hours[14].floors[i].use === "office"),
      ).size,
    ).toBeGreaterThan(15);
    for (const i of [1, 38]) {
      expect(colors[i]).toBe(EQUIPMENT_COLOR);
      expect(
        Math.max(...data.hours.map((h) => h.floors[i].floor_actual_kw)),
      ).toBeLessThan(70);
    }
    await page.waitForTimeout(500);
    const drawn = await page
      .locator(".floors-load-chart canvas")
      .first()
      .evaluate(
        (el, colors) => {
          const c = el as HTMLCanvasElement,
            p = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data,
            set = new Set<number>();
          for (let i = 0; i < p.length; i += 4)
            if (p[i + 3] === 255)
              set.add((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
          return colors.filter((color) =>
            set.has(parseInt(color.slice(1), 16)),
          );
        },
        [...new Set(colors)],
      );
    expect(drawn).toContain(EQUIPMENT_COLOR);
    expect(drawn.length).toBeGreaterThanOrEqual(10);
  });
