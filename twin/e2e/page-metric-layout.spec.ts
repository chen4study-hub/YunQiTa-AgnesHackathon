import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const size of [
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
  { width: 390, height: 844 },
])
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`metric pairs left aligned with adjacent baseline units ${size.width}`, async ({
    page,
  }) => {
    page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.log("CONSOLE", m.text());
    });
    await page.setViewportSize(size);
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await expect(page.locator(".bottombar")).toBeVisible();
    for (const [label, root, cells] of [
      ["楼层与电梯", ".floors-page", ".floors-metrics > div"],
      [
        "能源与告警",
        ".energy-page",
        ".energy-environment-metrics > div,.energy-cumulative > div,.energy-ems-totals > div",
      ],
    ]) {
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await expect(page.locator(".bottombar")).toBeVisible();
      await page.getByRole("button", { name: label }).click();
      await expect(page.locator(root)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const geometry = await page.locator(cells).evaluateAll((es) =>
        es.map((e) => {
          const l = e.querySelector(":scope > span")!,
            b = e.querySelector("b")!,
            n = b.querySelector("span")!,
            u = b.querySelector("small")!;
          const lr = l.getBoundingClientRect(),
            nr = n.getBoundingClientRect(),
            ur = u.getBoundingClientRect(),
            br = b.getBoundingClientRect(),
            er = e.getBoundingClientRect(),
            s = getComputedStyle(e);
          return {
            label: l.textContent?.trim(),
            unit: u.textContent?.trim(),
            cell: er.toJSON(),
            valueBounds: br.toJSON(),
            text: b.textContent,
            unitClass: u.className,
            numberClass: b.className,
            left: Math.abs(lr.left - nr.left),
            gap: ur.left - nr.right,
            vertical: br.top - lr.bottom,
            ratio:
              parseFloat(getComputedStyle(u).fontSize) /
              parseFloat(getComputedStyle(b).fontSize),
            unitSize: parseFloat(getComputedStyle(u).fontSize),
            numberSize: parseFloat(getComputedStyle(b).fontSize),
            baseline: getComputedStyle(b).alignItems,
            tabular: getComputedStyle(b).fontVariantNumeric,
            center: Math.abs(lr.top + br.bottom - (er.top + er.bottom)) / 2,
            padLeft: parseFloat(s.paddingLeft),
            padRight: parseFloat(s.paddingRight),
            overflow: e.scrollWidth - e.clientWidth,
          };
        }),
      );
      console.log(size.width, label, JSON.stringify(geometry));
      for (const g of geometry) {
        expect(g.unitClass).toContain("type-unit");
        expect(g.numberClass).toContain("type-number");
        expect(g.left).toBeLessThan(1);
        if (g.unit === "%") {
          expect(g.gap).toBe(0);
          expect(g.text).toMatch(/^\d+(?:\.\d+)?%$/);
        } else {
          expect(g.gap).toBeGreaterThanOrEqual(3);
          expect(g.gap).toBeLessThanOrEqual(4.1);
        }
        expect(g.vertical).toBeGreaterThanOrEqual(3.9);
        expect(g.unitSize).toBeGreaterThanOrEqual(12);
        expect(g.ratio).toBeCloseTo(Math.max(12, g.numberSize * 0.45) / g.numberSize, 2);
        expect(g.baseline).toBe("baseline");
        expect(g.tabular).toContain("tabular-nums");
        expect(g.center).toBeLessThanOrEqual(1);
        expect(g.padLeft).toBe(g.padRight);
        expect.soft(g.overflow, `${size.width} ${label}/${g.label}: ${g.text}`).toBeLessThanOrEqual(1);
      }
      if (label === "楼层与电梯") {
        await expect(
          page.locator(".floors-temperature-value.type-number .type-unit"),
        ).toHaveCount(6);
      }
      expect(geometry.filter((g) => g.unit === "%")).toHaveLength(1);
    }
  });
  });
