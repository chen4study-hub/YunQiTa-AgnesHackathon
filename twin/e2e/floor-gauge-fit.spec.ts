import { expect, test } from "@playwright/test";
import { isolateOpsTest, assertTemperatureToken } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
import { seekPageHour } from "./page-seek";
for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}: temperature readings and settings stay inside cells`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-07-23T14:00");
    await seekPageHour(page, 14);
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    const root = page.locator(".floors-page");
    await expect(root.locator(".floors-temperature-display")).toHaveCount(6);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    await expect(root.locator(".floors-list-card .floors-tag")).toHaveCount(0);
    await expect(root.locator(".floors-detail-card .floors-tag")).toHaveText(
      "BA 系统",
    );
    for (const hour of [0, 14, 23]) {
      await seekPageHour(page, hour);
      await page.waitForTimeout(450);
      const readings = await root
        .locator(".floors-temperature-value")
        .evaluateAll((es) =>
          es.map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect(),
              cell = el.closest(".floors-zone")!.getBoundingClientRect();
            return {
              fits: text.left >= cell.left && text.right <= cell.right,
              size: parseFloat(
                getComputedStyle(el.querySelector("b")!).fontSize,
              ),
            };
          }),
        );
      await assertTemperatureToken(page);
      for (const reading of readings) {
        expect(reading.fits).toBe(true);
        expect(reading.size).toBeGreaterThanOrEqual(24);
      }
      const settings = await root
        .locator(".floors-zone-setting")
        .evaluateAll((es) =>
          es.map((e) => {
            const p = e.getBoundingClientRect(),
              cell = e.closest(".floors-zone")!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(e);
            const text = range.getBoundingClientRect();
            return {
              left: text.left - cell.left,
              right: cell.right - text.right,
              bottom: cell.bottom - text.bottom,
              overflow: e.scrollWidth - e.clientWidth,
              boxRight: cell.right - p.right,
            };
          }),
        );
      for (const setting of settings) {
        expect(setting.left).toBeGreaterThanOrEqual(1);
        expect(setting.right).toBeGreaterThanOrEqual(1);
        expect(setting.bottom).toBeGreaterThanOrEqual(0);
        expect(setting.overflow).toBeLessThanOrEqual(1);
        expect(setting.boxRight).toBeGreaterThanOrEqual(1);
      }
    }
    await assertShellScrolling(page, "Ops temperature cells");
    await test.info().attach("gauge-fit", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}
