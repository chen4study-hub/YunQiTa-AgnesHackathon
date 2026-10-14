import { DESKTOP_125, RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
import { assertAlertsReachable } from "./alert-visibility";
import { expect, test } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test.beforeEach(async ({ page }) => isolateOpsTest(page));

for (const size of [
  { width: 1366, height: 768, minimum: 120 },
  { ...DESKTOP_125, minimum: 140 },
  { width: 1920, height: 1080, minimum: 150 },
  { width: 2560, height: 1080, minimum: 150 },
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`energy 24-hour chart height and contained scrollable layout ${size.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    await page.goto(
      `/?source=file&at=2026-10-12T${size.width === 1366 ? "23" : "14"}:00`,
    );
    await page.getByRole("button", { name: "能源与告警" }).click();
    await page.evaluate(() => document.fonts.ready);
    const charts = page.locator(".energy-timeseries");
    await expect(charts).toHaveCount(2);
    const geometry = await page.locator(".energy-page").evaluate((root) => {
      const bounds = (selector: string) => {
        const r = root.querySelector(selector)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      };
      return {
        ems: bounds(".energy-ems .energy-timeseries"),
        environment: bounds(".energy-environment .energy-timeseries"),
        emsTotals: bounds(".energy-ems-totals"),
        alerts: bounds(".energy-alerts"),
        header: bounds(".energy-alert-table thead"),
        main: document.querySelector("main")!.getBoundingClientRect().toJSON(),
        table: bounds(".energy-table-scroll"),
        tableOverflow: getComputedStyle(
          root.querySelector(".energy-table-scroll")!,
        ).overflowY,
        pageOverflow: root.scrollHeight - root.clientHeight,
        documentOverflow: document.documentElement.scrollHeight - innerHeight,
      };
    });
    console.log(size.width, JSON.stringify(geometry));
    for (const chart of [geometry.ems, geometry.environment])
      expect(chart.height).toBeGreaterThanOrEqual(size.minimum);
    expect(geometry.emsTotals.top - geometry.ems.bottom).toBeGreaterThanOrEqual(
      10,
    );
    expect(geometry.table.bottom).toBeLessThanOrEqual(geometry.alerts.bottom);
    if (size.width === 1366)
      await assertAlertsReachable(page, "Ops energy 1366 after main scroll");
    await assertShellScrolling(page, "Ops energy chart heights");
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("energy.png") });
  });
  });
}
