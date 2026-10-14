import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";

for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  { width: 1600, height: 830, dpr: 1 },
  // 1600x830 physical pixels at Windows 125% can expose this CSS viewport.
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`overview metric content bounds ${size.width}@${size.dpr}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("values and units retain their font floors and never enter card padding", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await freezeTestHmr(page);
      await page.route("**/api/**", (route) => route.abort());
      for (const hour of [4, 14, 23]) {
        await page.goto(
          `/?source=file&at=2026-10-13T${String(hour).padStart(2, "0")}:00`,
          { waitUntil: "domcontentloaded" },
        );
        await expect(page.locator(".overview-number")).toHaveCount(3);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        const measurements = await page
          .locator(".overview-number")
          .evaluateAll((elements) =>
            elements.map((el) => {
              const card = el.closest(".card")!;
              const rect = card.getBoundingClientRect(),
                style = getComputedStyle(card);
              const contentLeft =
                rect.left +
                parseFloat(style.borderLeftWidth) +
                parseFloat(style.paddingLeft);
              const contentRight =
                rect.right -
                parseFloat(style.borderRightWidth) -
                parseFloat(style.paddingRight);
              const contentBottom =
                rect.bottom -
                parseFloat(style.borderBottomWidth) -
                parseFloat(style.paddingBottom);
              return {
                label: card.getAttribute("aria-label"),
                contentLeft,
                contentRight,
                contentBottom,
                numberFont: parseFloat(getComputedStyle(el).fontSize),
                unitFont: parseFloat(
                  getComputedStyle(el.querySelector(".type-unit")!).fontSize,
                ),
                bounds: Array.from(
                  el.querySelectorAll(
                    ".animated-number-text, .animated-number-text > span, .type-unit",
                  ),
                ).map((child) => {
                  const r = child.getBoundingClientRect();
                  return { left: r.left, right: r.right, bottom: r.bottom };
                }),
              };
            }),
          );
        for (const m of measurements) {
          expect(
            m.numberFont,
            `${m.label}: no numeric font reduction`,
          ).toBeGreaterThanOrEqual(24);
          expect(
            m.unitFont,
            `${m.label}: no unit font reduction`,
          ).toBeGreaterThanOrEqual(12);
          for (const r of m.bounds) {
            expect(r.left, `${m.label}: left padding`).toBeGreaterThanOrEqual(
              m.contentLeft - 0.5,
            );
            expect(r.right, `${m.label}: right padding`).toBeLessThanOrEqual(
              m.contentRight + 0.5,
            );
            expect(r.bottom, `${m.label}: bottom padding`).toBeLessThanOrEqual(
              m.contentBottom + 0.5,
            );
          }
        }
        if (hour === 23)
          await page
            .locator(".overview-left")
            .screenshot({ path: info.outputPath("metric-content.png") });
      }
    });
  });
  });
