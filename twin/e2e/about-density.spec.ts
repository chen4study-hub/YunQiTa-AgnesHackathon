import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
  DESKTOP_125,
])
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`About content density, evidence and attribution ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/?source=file");
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-page")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await expect(page.locator(".about-page")).toContainText("80,038 m²");
    await expect(page.locator(".about-page")).toContainText("BDG2 / Hog");
    await expect(page.locator(".about-page")).toContainText(
      "由 Agnes Harness（AGH）协助开发",
    );
    await expect(page.locator(".about-page")).not.toContainText(
      /模拟|估计|开发服务器|开发模式|开发工作区|典型日|情景|代表日/,
    );
    await expect(page.locator(".about-page")).toContainText(
      "数据接入：BDG2 公开数据集",
    );
    await expect(page.locator(".about-build")).toContainText(/v\d+\.\d+\.\d+/);
    await expect(page.locator(".about-build")).toContainText(/[a-f0-9]{7,}/);
    await expect(page.locator(".about-rate-row")).toHaveCount(3);
    await expect(page.locator(".about-selling li")).toHaveCount(3);
    await expect(page.locator(".architecture-details > div")).toHaveCount(5);
    await expect(page.locator(".about-metrics > div")).toHaveCount(5);
    const metrics = await page
      .locator(".about-dense > .card")
      .evaluateAll((es) =>
        es.map((el) => {
          const css = getComputedStyle(el),
            body = el.querySelector(".about-card-body")!;
          const contentHeight =
            el.clientHeight -
            parseFloat(css.paddingTop) -
            parseFloat(css.paddingBottom);
          return {
            name: el.className,
            blank: 1 - body.getBoundingClientRect().height / contentHeight,
            clipped: el.scrollHeight > el.clientHeight + 1,
          };
        }),
      );
    console.log(size.width, JSON.stringify(metrics));
    expect(metrics.every((m) => m.blank <= 0.3 && !m.clipped)).toBe(true);
    const logos = await page.evaluate(() => ({
      project: document.querySelector(".about-logo")!.getBoundingClientRect()
        .width,
      agh: document.querySelector(".agh-logo")!.getBoundingClientRect().width,
    }));
    expect(logos.project).toBeGreaterThan(logos.agh * 4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (size.width > 1180) {
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
      ).toBe(size.height);
    }
    for (const link of await page.locator(".about-license a").all())
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(35.99);
    const license = await page.request.get(
      (await page
        .getByRole("link", { name: "第三方许可", exact: true })
        .getAttribute("href"))!,
    );
    expect(license.ok()).toBe(true);
  });
  });
