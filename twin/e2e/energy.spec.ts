import { DESKTOP_125 } from "./viewport-profile";
import { seekPageHour } from "./page-seek";
import { test, expect } from "@playwright/test";
import {
  opsDay,
  exportedAlerts,
  assertOpsAlerts,
  isolateOpsTest,
} from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  DESKTOP_125,
]) {
  test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test(`energy content never overlaps at ${viewport.width}px and preserves actual Ops events`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await seekPageHour(page, 14);
    await page.getByRole("button", { name: "能源与告警" }).click();
    await expect(page.locator(".energy-page")).toHaveAttribute(
      "data-time",
      "14",
    );
    const day = opsDay("2026-10-12");
    await assertOpsAlerts(page, day, 14);
    const socLogs = await page
      .locator(".energy-alert-table tbody tr")
      .allTextContents();
    // Only assert SOC content when the export actually supplied a SOC alert.
    expect(socLogs.some((t) => /SOC [\d.]+\s+%/.test(t))).toBe(false);
    await expect(page.locator(".energy-use-legend li")).toHaveCount(5);
    await expect(page.locator(".energy-page")).not.toContainText("固定派生");
    await page.waitForTimeout(350);
    const boxes = await page.locator(".energy-page").evaluate((root) => {
      const rect = (selector: string) => {
        const r = root.querySelector(selector)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return {
        donut: rect(".energy-donut-chart"),
        legend: rect(".energy-use-legend"),
        cumulative: rect(".energy-section-heading"),
        ems: rect(".energy-ems"),
        emsChart: rect(".energy-ems .energy-timeseries"),
        emsTotals: rect(".energy-ems-totals"),
        cumulativeGrid: rect(".energy-cumulative"),
        endUse: rect(".energy-end-use"),
        table: rect(".energy-table-scroll"),
        environment: rect(".energy-environment"),
        environmentChart: rect(".energy-environment .energy-timeseries"),
        alerts: rect(".energy-alerts"),
        top: Array.from(root.children)
          .slice(0, 3)
          .map((e) => e.getBoundingClientRect().bottom),
        width: root.clientWidth,
        scrollWidth: root.scrollWidth,
        height: root.clientHeight,
        scrollHeight: root.scrollHeight,
      };
    });
    expect(boxes.donut.bottom).toBeLessThanOrEqual(boxes.cumulative.top);
    expect(boxes.legend.bottom).toBeLessThanOrEqual(boxes.cumulative.top);
    const emsGap = boxes.emsTotals.top - boxes.emsChart.bottom;
    console.log(viewport.width, "EMS chart / totals gap", emsGap);
    expect(emsGap).toBeGreaterThanOrEqual(10);
    expect(boxes.emsTotals.bottom).toBeLessThanOrEqual(boxes.ems.bottom);
    expect(boxes.cumulativeGrid.bottom).toBeLessThanOrEqual(
      boxes.endUse.bottom,
    );
    expect(boxes.table.bottom).toBeLessThanOrEqual(boxes.alerts.bottom);
    expect(boxes.environmentChart.bottom).toBeLessThanOrEqual(
      boxes.environment.bottom,
    );
    expect(Math.max(...boxes.top)).toBeLessThan(boxes.alerts.top);
    expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.width + 1);
    await assertShellScrolling(
      page,
      "Ops energy permits necessary vertical scrolling",
    );
    expect(boxes.table.bottom).toBeLessThanOrEqual(boxes.alerts.bottom);
    expect(boxes.donut.bottom - boxes.donut.top).toBeLessThanOrEqual(200);
    const visibleRows = await page
      .locator(".energy-table-scroll")
      .evaluate((e) => {
        const r = e.getBoundingClientRect();
        return Array.from(e.querySelectorAll("tbody tr")).filter((row) => {
          const b = row.getBoundingClientRect();
          return b.top >= r.top && b.bottom <= r.bottom;
        }).length;
      });
    expect(visibleRows).toBeGreaterThanOrEqual(
      Math.min(exportedAlerts(day, 14).length, viewport.width <= 1600 ? 4 : 6),
    );
  });
  });
}

test("Ops work orders sort first and follow the selected hour", async ({
  page,
}) => {
  const date = "2026-10-01",
    day = opsDay(date);
  await page.goto(`/?source=file&at=${date}T14:00`);
  await page.getByRole("button", { name: "能源与告警" }).click();
  for (const hour of [5, 14, 23]) {
    await seekPageHour(page, hour);
    await expect(page.locator(".energy-page")).toHaveAttribute(
      "data-time",
      String(hour),
    );
    await assertOpsAlerts(page, day, hour);
    const records = exportedAlerts(day, hour);
    for (const record of records) {
      const row = page.locator(`tr[data-alert-id="${record.id}"]`);
      await expect(row).toHaveAttribute("data-agent", String(record.agent));
      await expect(row).toContainText(record.content);
      for (const check of record.suggested_checks)
        await expect(row).toContainText(check);
    }
  }
  await assertShellScrolling(page, "Ops work-order table");
});
