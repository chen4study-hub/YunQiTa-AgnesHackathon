import { expect, test } from "@playwright/test";
import { DESKTOP_125 } from "./viewport-profile";
import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
const energySelector =
  ".energy-donut-total b, .energy-use-legend b, .energy-cumulative b, .energy-power-row b, .energy-ems-totals b, .energy-environment-metrics b, .energy-soc-reading b";
const floorSelector = ".floors-metrics b, .floors-temperature-value";
for (const size of [
  { width: 390, height: 844, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
]) {
  test.describe(`local NBSP ${size.width} DPR ${size.dpr}`, () => {
    test.use({ deviceScaleFactor: size.dpr });
    test("DOM text includes NBSP and every number-unit pair stays on one line", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await isolateOpsTest(page);
      await page.setViewportSize(size);
      await page.goto("/?source=file&at=2026-10-12T14:00", {
        waitUntil: "domcontentloaded",
      });
      for (const [name, root, selector] of [
        ["能源与告警", ".energy-page", energySelector],
        ["楼层与电梯", ".floors-page", floorSelector],
      ]) {
        await page.getByRole("button", { name }).click();
        await expect(page.locator(`${root}[data-time="14"]`)).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const readings = await page.locator(selector).evaluateAll((elements) =>
          elements.map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const rects = Array.from(range.getClientRects()).filter(
              (r) => r.width > 0 && r.height > 0,
            );
            const bounds = el.getBoundingClientRect();
            const number =
              el.querySelector(".energy-number, .floors-number, b") ??
              el.firstElementChild;
            const unit = el.querySelector(".type-unit");
            return {
              text: el.textContent!,
              rects: rects.map((r) => ({ top: r.top, bottom: r.bottom })),
              font: parseFloat(getComputedStyle(el).fontSize),
              unitFont: unit
                ? parseFloat(getComputedStyle(unit).fontSize)
                : null,
              gap: getComputedStyle(el).columnGap,
              overflow: Math.max(
                0,
                ...rects.map((r) => r.right - bounds.right),
              ),
              numericText: number?.textContent,
              unitText: unit?.textContent,
            };
          }),
        );
        expect(readings.length).toBeGreaterThanOrEqual(
          name === "能源与告警" ? 20 : 12,
        );
        for (const row of readings) {
          if (row.text.endsWith("%")) expect(row.text).toMatch(/(?:\d|—)%$/);
          else
            expect(row.text).toMatch(
              /(?:\d|—)\u00a0(?:kW|kWh|℃|ppm|μg\/m³|m³\/h|元|人)$/,
            );
          // Inline pieces may have different font sizes, but must share a vertical band.
          expect(Math.max(...row.rects.map((r) => r.top))).toBeLessThan(
            Math.min(...row.rects.map((r) => r.bottom)),
          );
          expect(row.overflow).toBeLessThanOrEqual(1);
          if (row.unitText && !row.text.endsWith("%")) {
            expect(row.unitText).toMatch(/^\u00a0/);
            expect(["normal", "0px"]).toContain(row.gap);
          }
        }
        await assertShellScrolling(page, name);
        if (size.width === 1280)
          await page.screenshot({
            path: info.outputPath(
              name === "能源与告警"
                ? "energy-nbsp-1280.png"
                : "floors-nbsp-1280.png",
            ),
          });
      }
    });
  });
}
