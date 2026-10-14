import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
const sizes = [
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
];
for (const size of sizes)
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`scrollall/mobshot energy ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await page
      .getByRole("button", { name: "能源与告警", exact: false })
      .click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    const geometry = await page.locator(".energy-ems").evaluate((card) => {
      const bounds = (selector: string) =>
        Array.from(card.querySelectorAll(selector)).map((el) => ({
          selector,
          text: el.textContent?.trim(),
          r: el.getBoundingClientRect().toJSON(),
        }));
      const groups = [
        bounds(
          ":scope > .energy-heading,:scope > .energy-ems-top,:scope > .energy-chart-slot,:scope > .energy-ems-totals",
        ),
        bounds(".energy-ems-top > *"),
        bounds(".energy-ems-totals > div"),
        bounds(".energy-soc-reading > *"),
      ];
      for (const cell of card.querySelectorAll(".energy-ems-totals > div"))
        groups.push(
          Array.from(cell.children).map((el) => ({
            selector: el.className,
            text: el.textContent?.trim(),
            r: el.getBoundingClientRect().toJSON(),
          })),
        );
      for (const row of card.querySelectorAll(".energy-power-row"))
        groups.push(
          Array.from(row.children).map((el) => ({
            selector: el.className,
            text: el.textContent?.trim(),
            r: el.getBoundingClientRect().toJSON(),
          })),
        );
      const overlaps = groups.flatMap((es) =>
        es.flatMap((a, i) =>
          es.slice(i + 1).flatMap((b) => {
            const x =
                Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left),
              y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
            return x > 1 && y > 1 ? [{ a: a.text, b: b.text, x, y }] : [];
          }),
        ),
      );
      const numberOverflows = Array.from(card.querySelectorAll("b"))
        .map((el) => ({
          text: el.textContent,
          excess: el.scrollWidth - el.clientWidth,
        }))
        .filter((x) => x.excess > 1);
      return { overlaps, numberOverflows };
    });
    console.log(size.width, JSON.stringify(geometry));
    expect(geometry.overlaps).toEqual([]);
    expect(geometry.numberOverflows).toEqual([]);
    await page.screenshot({
      path: `test-results/energy-${size.width}.png`,
      fullPage: true,
    });
    await page
      .locator(".energy-ems")
      .screenshot({ path: `test-results/ems-${size.width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    if (size.width > 640)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight + 1,
        ),
      ).toBe(true);
  });
  });
