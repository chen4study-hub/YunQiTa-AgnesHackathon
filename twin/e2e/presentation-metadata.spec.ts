import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
  DESKTOP_125,
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`no user-facing contract version across all pages ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    await expect(page.locator(".overview-forecast-heading > small")).toHaveText(
      "最近 2 点实测 + 未来 24 点预测",
    );
    for (const name of [
      "总览",
      "预测与风险",
      "Agent 决策",
      "楼层与电梯",
      "能源与告警",
      "关于",
    ]) {
      await page.getByRole("button", { name, exact: false }).click();
      const text = await page.locator(".dashboard").innerText();
      expect(text, name).not.toMatch(/(?:数据)?契约\s*(?:版本)?\s*1\.\d+/);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        name,
      ).toBe(true);
    }
    await expect(page.locator(".about-build")).not.toContainText(
      /契约\s*(?:版本)?\s*1\.\d+/,
    );
    console.log(
      `${size.width}: caption clean; all 6 page texts clean; document overflow=0`,
    );
  });
  });
}
