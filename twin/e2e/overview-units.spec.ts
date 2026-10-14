import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { setTimelineHour } from "./timeline-helper";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  await page.route("**/api/**", r => r.abort());
});
for (const [width, height, dpr = 1] of [
  [390, 844],
  [DESKTOP_125.width, DESKTOP_125.height, DESKTOP_125.dpr],
  [1366, 768],
  [1600, 830],
  [1920, 1080],
])
  test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`metric units follow values using public type scale ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await expect(page.locator(".overview-number")).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    for (const hour of [0, 14, 23]) {
      await setTimelineHour(page, hour);
      await expect.poll(() => page.locator(".overview-number .animated-number-text").evaluateAll(es => es.every(e => e.textContent === e.getAttribute("aria-label")))).toBe(true);
      const measures = await page
        .locator(".overview-number")
        .evaluateAll((es) =>
          es.map((e) => {
            const number = e.querySelector(".animated-number-text")!,
              unit = e.querySelector(".type-unit")!,
              nr = number.getBoundingClientRect(),
              ur = unit.getBoundingClientRect(),
              css = getComputedStyle(e);
            return {
              number: nr.toJSON(), unit: ur.toJSON(), container: e.getBoundingClientRect().toJSON(), text: e.textContent, gap: ur.left - nr.right,
              parent: parseFloat(css.fontSize),
              size: parseFloat(getComputedStyle(unit).fontSize),
              scale: (() => {
                const probe = document.createElement("span");
                probe.style.cssText =
                  "position:absolute;visibility:hidden;font-size:var(--font-unit)";
                e.append(probe);
                const size = parseFloat(getComputedStyle(probe).fontSize);
                probe.remove();
                return size;
              })(),
              rowGap: ur.top - nr.bottom,
              bottom: Math.max(ur.bottom, nr.bottom) <= e.getBoundingClientRect().bottom + 1,
              numberRight: nr.right <= e.getBoundingClientRect().right + 1,
              sameLine: ur.top < nr.bottom && ur.bottom > nr.top,
              right: ur.right <= e.getBoundingClientRect().right + 1,
            };
          }),
        );
      console.log("OVERVIEW_UNIT_GEOMETRY " + JSON.stringify({ width, height, hour, measures }));
      await info.attach(`unit-geometry-${hour}.json`, {
        body: JSON.stringify({ width, height, hour, measures }, null, 2),
        contentType: "application/json",
      });
      for (const m of measures) {
        // A whole value may move to another row; its number and unit may never split.
        // Baseline-aligned smaller units need not have the same top as the number.
        const diagnostic = JSON.stringify({ width, height, hour, ...m });
        expect.soft(m.sameLine, diagnostic).toBe(true);
        expect.soft(m.gap, diagnostic).toBeGreaterThanOrEqual(0);
        expect.soft(m.gap, diagnostic).toBeLessThan(m.parent * 0.4);
        expect(Number.isFinite(m.scale)).toBe(true);
        expect(m.size).toBeCloseTo(m.scale, 2);
        expect(m.right && m.numberRight && m.bottom, JSON.stringify({hour, ...m})).toBe(true);
      }
    }
    await assertShellScrolling(page, `overview units ${width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  });
