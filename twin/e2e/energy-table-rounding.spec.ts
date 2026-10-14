import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { seekPageHour } from "./page-seek";
import { opsDay, assertOpsAlerts, isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const viewport of [
  { width: 1600, height: 830 },
  DESKTOP_125,
  { width: 1366, height: 768 },
]) {
  test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test(`${viewport.width}: table rounding is not scrolling, real excess is`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await seekPageHour(page, 14);
    await page.getByRole("button", { name: "能源与告警" }).click();
    const host = page.locator(".energy-table-scroll");
    await assertOpsAlerts(page, opsDay("2026-10-12"), 14);
    // 1600/1.25 x 830/1.25 is the effective CSS viewport at browser 125% zoom.
    for (const axis of ["x", "y"] as const) {
      for (const excess of [1, 3, 22]) {
        await host.evaluate(
          (e, { axis, excess }) => {
            const table = e.querySelector("table")!;
            const size = axis === "x" ? table.scrollWidth : table.scrollHeight;
            table.style[axis === "x" ? "width" : "height"] = `${size}px`;
            (e as HTMLElement).style[axis === "x" ? "width" : "height"] =
              `${size - excess}px`;
          },
          { axis, excess },
        );
        await page.waitForTimeout(100);
        const overflow = await host.evaluate(
          (e, axis) =>
            axis === "x"
              ? getComputedStyle(e).overflowX
              : getComputedStyle(e).overflowY,
          axis,
        );
        expect(overflow).toBe(excess <= 3 ? "hidden" : "auto");
        if (excess === 22) {
          const pos = await host.evaluate((e, axis) => {
            if (axis === "x") e.scrollLeft = 10;
            else e.scrollTop = 10;
            return axis === "x" ? e.scrollLeft : e.scrollTop;
          }, axis);
          expect(pos).toBeGreaterThan(0);
        }
        await host.evaluate((e) => {
          const table = e.querySelector("table")!;
          table.style.width = "";
          table.style.height = "";
          (e as HTMLElement).style.width = "";
          (e as HTMLElement).style.height = "";
          e.scrollTop = 0;
          e.scrollLeft = 0;
        });
        await page.waitForTimeout(100);
      }
    }
  });
  });
}
