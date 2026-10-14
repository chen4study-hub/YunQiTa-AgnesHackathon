import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { isolateOpsTest, assertTemperatureToken } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const size of [
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`scrollall/mobshot temperature cards ${size.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    await page.goto("/?source=file&at=2026-07-23T14:00");
    await page
      .getByRole("button", { name: "楼层与电梯", exact: false })
      .click();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".floors-zone-setting").first()).toContainText(
      /设定 [\d.]+ ℃/,
    );
    await page.waitForTimeout(500);
    await expect(page.locator(".floors-temperature-display")).toHaveCount(6);
    const geometry = await page.locator(".floors-zone").evaluateAll((es) =>
      es.map((card) => {
        const number = card.querySelector(".floors-temperature-value")!,
          digits = number.querySelector("b")!,
          unit = number.querySelector("small")!,
          setting = card.querySelector(".floors-zone-setting")!;
        const cr = card.getBoundingClientRect(),
          nr = number.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(setting);
        const sr = range.getBoundingClientRect();
        const groups = [
          Array.from(card.children),
          Array.from(
            card.querySelector(".floors-temperature-display")!.children,
          ),
        ];
        const overlaps = groups.flatMap((group) =>
          group.flatMap((a, i) =>
            group.slice(i + 1).flatMap((b) => {
              const ar = a.getBoundingClientRect(),
                br = b.getBoundingClientRect(),
                x = Math.min(ar.right, br.right) - Math.max(ar.left, br.left),
                y = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
              return x > 1 && y > 1
                ? [{ x, y, a: a.className, b: b.className }]
                : [];
            }),
          ),
        );
        const band = card
            .querySelector(".floors-temperature-band")!
            .getBoundingClientRect(),
          limit = card
            .querySelector(".floors-temperature-limit")!
            .getBoundingClientRect();
        return {
          size: parseFloat(getComputedStyle(digits).fontSize),
          unit: parseFloat(getComputedStyle(unit).fontSize),
          center: Math.abs(nr.left + nr.right - (cr.left + cr.right)) / 2,
          overflow: card.scrollWidth - card.clientWidth,
          setting: parseFloat(getComputedStyle(setting).fontSize),
          fits: sr.left >= cr.left && sr.right <= cr.right,
          limit: (limit.left - band.left) / band.width,
          overlaps,
        };
      }),
    );
    await assertTemperatureToken(page);
    console.log(size.width, JSON.stringify(geometry));
    for (const g of geometry) {
      expect(g.size).toBeGreaterThanOrEqual(24);
      expect(g.unit).toBeLessThan(g.size * 0.6);
      expect(g.center).toBeLessThanOrEqual(1);
      expect(g.setting).toBeGreaterThanOrEqual(10);
      expect(g.fits).toBe(true);
      expect(g.overflow).toBeLessThanOrEqual(1);
      expect(g.limit).toBeCloseTo(5 / 6, 2);
      expect(g.overlaps).toEqual([]);
    }
    for (const card of await page.locator(".floors-zone").all()) {
      const label = await card
        .locator(".floors-temperature-scale span")
        .nth(1)
        .boundingBox();
      const limit = await card
        .locator(".floors-temperature-limit")
        .boundingBox();
      const error = Math.abs(
        label!.x + label!.width / 2 - (limit!.x + limit!.width / 2),
      );
      console.log(size.width, "27 label horizontal error", error);
      expect(error).toBeLessThan(3);
      const endpoints = await card
        .locator(".floors-temperature-scale span")
        .all();
      for (const i of [0, 2]) {
        const end = await endpoints[i].boundingBox();
        const x =
          Math.min(end!.x + end!.width, label!.x + label!.width) -
          Math.max(end!.x, label!.x);
        const y =
          Math.min(end!.y + end!.height, label!.y + label!.height) -
          Math.max(end!.y, label!.y);
        expect(x <= 0 || y <= 0).toBe(true);
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await assertShellScrolling(page, "Ops temperature cards");
    await page.screenshot({
      path: info.outputPath(`floors-${size.width}.png`),
      fullPage: true,
    });
    await page
      .locator(".floors-zones")
      .screenshot({ path: info.outputPath(`temperature-${size.width}.png`) });
  });
  });
}
