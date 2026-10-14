import { test, expect } from "@playwright/test";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";

test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  await page.route("**/api/**", (r) => r.abort());
});
for (const [width, height] of [
  [1280, 664],
  [1366, 768],
  [1920, 1080],
  [390, 844],
]) {
  for (const hour of [14, 23]) {
    test(`atomic overview readings ${width} at ${hour}:00`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto(`/?source=file&at=2026-10-12T${hour}:00`);
      await expect(page.locator(".overview-number")).toHaveCount(3);
      await expect(page.locator(".timeline")).toHaveAttribute(
        "data-time",
        String(hour),
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (a) =>
                a.effect instanceof KeyframeEffect &&
                (a.effect.target as Element)?.closest(".page-enter"),
            )
            .map((a) => a.finished.catch(() => {})),
        );
      });
      await expect
        .poll(() =>
          page
            .locator(".overview-number .animated-number-text")
            .evaluateAll((es) =>
              es.every((e) => e.textContent === e.getAttribute("aria-label")),
            ),
        )
        .toBe(true);
      const values = await page.locator(".overview-number").evaluateAll((es) =>
        es.map((el) => {
          const card = el.closest(".card")!,
            cr = card.getBoundingClientRect(),
            cs = getComputedStyle(card);
          const label = card
            .querySelector(":scope > small")!
            .getBoundingClientRect();
          const number = el
            .querySelector(".animated-number-text")!
            .getBoundingClientRect();
          const unit = el.querySelector(".type-unit")!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return {
            text: el.textContent,
            sameLine: unit.top < number.bottom && unit.bottom > number.top,
            padded:
              number.left >= cr.left + parseFloat(cs.paddingLeft) - 1 &&
              unit.right <= cr.right - parseFloat(cs.paddingRight) + 1,
            belowLabel: box.top >= label.bottom - 1,
            nowrap: getComputedStyle(el).flexWrap,
            size: parseFloat(getComputedStyle(el).fontSize),
            unitSize: parseFloat(
              getComputedStyle(el.querySelector(".type-unit")!).fontSize,
            ),
          };
        }),
      );
      for (const v of values) {
        expect(v.sameLine, v.text!).toBe(true);
        expect(v.padded, v.text!).toBe(true);
        expect(v.belowLabel, v.text!).toBe(true);
        expect(v.nowrap).toBe("nowrap");
        expect(v.size).toBeGreaterThanOrEqual(24);
        expect(v.unitSize).toBeGreaterThanOrEqual(12);
      }
      expect(values[1].text).toContain(
        hour === 14 ? "13,875.9 kWh" : "23,171.6 kWh",
      );
      const summaryFits = await page
        .locator(".summary-grid b")
        .evaluateAll((es) =>
          es.every((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return (
              new Set(
                Array.from(range.getClientRects()).map((r) =>
                  Math.round(r.top),
                ),
              ).size === 1 && el.scrollWidth <= el.clientWidth + 1
            );
          }),
        );
      expect(summaryFits).toBe(true);
      await assertShellScrolling(page, `atomic values ${width} at ${hour}`);
      await page
        .locator(".overview-left")
        .screenshot({ path: info.outputPath("metrics.png") });
      await page.screenshot({ path: info.outputPath("overview.png") });
    });
  }
}
