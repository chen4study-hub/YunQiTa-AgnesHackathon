import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
import {
  auditPages,
  installCanvasTextAudit,
  clearCanvasTextAudit,
  canvasTexts,
  visitAuditPage,
  chartHosts,
} from "./canvas-text-audit";

test.use({
  viewport: DESKTOP_125,
  deviceScaleFactor: DESKTOP_125.dpr,
});
test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  await installCanvasTextAudit(page);
});

for (const [name, id] of auditPages) {
  test(`canvas tooltip grid precision: ${name}`, async ({ page }, info) => {
    test.setTimeout(180000);
    await page.goto("/?source=file&at=2026-10-12T18:00");
    await visitAuditPage(page, name, id);
    const hosts = await chartHosts(page);
    if (id !== "agent" && id !== "about")
      expect(
        await hosts.count(),
        `${name} must expose its ECharts`,
      ).toBeGreaterThan(0);
    const violations: unknown[] = [],
      coverage: unknown[] = [];
    for (let i = 0; i < (await hosts.count()); i++) {
      const host = hosts.nth(i);
      const target = `${id}-${i}`;
      const chart = await host.evaluate((el, target) => {
        (el as HTMLElement).dataset.auditChart = target;
        return el.getAttribute("aria-label") || el.className;
      }, target);
      await host.scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      const box = await host.boundingBox();
      expect(box, `${name}/${chart} has a hoverable box`).not.toBeNull();
      let paints = 0,
        points = 0;
      for (const y of [0.25, 0.5, 0.75]) {
        for (let tenth = 1; tenth <= 9; tenth++) {
          // Hide the previous tooltip before each independent sample.
          await page.mouse.move(1, 1);
          await page.waitForTimeout(40);
          await clearCanvasTextAudit(page, target);
          const x = tenth / 10;
          await page.mouse.move(
            box!.x + box!.width * x,
            box!.y + box!.height * y,
          );
          await page.waitForTimeout(120);
          const samples = await canvasTexts(page);
          points++;
          paints += samples.length;
          for (const text of new Set(samples.map((s) => s.text))) {
            // Exempt only the price number directly carrying the price unit, not the entire line.
            const nonPrice = text.replace(
              /-?[\d,]+\.\d+\s*元\s*\/\s*kWh/gi,
              "PRICE",
            );
            if (
              /\d+\.\d{2,}/.test(nonPrice) ||
              /^\s*\d+\.\d{2,}\s*$/.test(text)
            ) {
              violations.push({ page: name, chart, index: i, x, y, text });
            }
          }
        }
      }
      coverage.push({ page: name, chart, index: i, points, paints });
      if (!paints)
        violations.push({
          page: name,
          chart,
          index: i,
          error: "No canvas text painted during all 27 hover points",
        });
    }
    // Agent/About may have no ECharts; record that explicitly rather than inventing chart fixtures.
    await info.attach("tooltip-grid.json", {
      body: JSON.stringify({ coverage, violations }, null, 2),
      contentType: "application/json",
    });
    console.log(
      "TOOLTIP_GRID " +
        JSON.stringify({
          page: name,
          charts: await hosts.count(),
          coverage,
          violations,
        }),
    );
    expect(
      violations,
      `${name}: chart and matching text in tooltip-grid.json`,
    ).toEqual([]);
  });
}
