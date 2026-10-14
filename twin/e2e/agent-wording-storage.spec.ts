import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { assertDisplayText } from "./agent-forecast-visible";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
]) {
  test.describe(`operator wording ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("missing grounding and charge direction are clear and fully visible", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T01:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page.evaluate(() => document.fonts.ready);
      const chain = page.locator(".agent-chain");
      await expect(chain).toContainText("数字取自预测与环境记录");
      await expect(chain).not.toContainText("核对结果未提供");
      const table = page.locator(".agent-comparison table");
      await expect(
        table
          .locator("tr")
          .filter({ hasText: "保守调度" })
          .locator(".agent-candidate-storage"),
      ).toHaveText("充电 250.0");
      await expect(table.locator("thead")).toContainText("储能");
      await expect(table.locator("thead")).toContainText("kW");
      for (const cell of await table
        .locator(".agent-candidate-storage")
        .all()) {
        expect((await cell.innerText()).trim()).toMatch(
          /^(充电|放电|待机) [\d,]+\.\d$/,
        );
        const m = await cell.evaluate((e) => {
          const r = e.getBoundingClientRect(),
            value = e.querySelector(".smooth-value")!.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            valueTop: value.top,
            valueBottom: value.bottom,
            valueLeft: value.left,
            valueRight: value.right,
          };
        });
        expect(m.valueTop).toBeGreaterThanOrEqual(m.top - 1);
        expect(m.valueBottom).toBeLessThanOrEqual(m.bottom + 1);
        expect(m.valueLeft).toBeGreaterThanOrEqual(m.left);
        expect(m.valueRight).toBeLessThanOrEqual(m.right + 1);
      }
      await assertDisplayText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(size.width);
      await table.scrollIntoViewIfNeeded();
      await expect(
        table.locator("tr").filter({ hasText: "保守调度" }),
      ).toBeInViewport();
      await page.screenshot({
        path: info.outputPath(`${size.width}-agent-wording.png`),
      });
    });
  });
  });
}
