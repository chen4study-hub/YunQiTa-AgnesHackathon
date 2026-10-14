import { test, expect } from "@playwright/test";

test("about and packaged license notices", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?source=mock");
  await expect(page.locator('[data-anchor="tower"]')).toContainText(
    /置信 \d+\.\d%/,
  );
  await page.getByRole("button", { name: "关于 ABOUT" }).click();
  await expect(page.locator(".about-page")).toContainText(
    "由 Agnes Harness（AGH）协助开发",
  );
  const link = page.getByRole("link", { name: "第三方许可", exact: true });
  const response = await page.request.get((await link.getAttribute("href"))!);
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain("Permission is hereby granted");
  await expect(page.locator(".credit")).toContainText("Scientific Data 7, 368");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".about-page .card")).toHaveCount(6);
  await expect(page.locator(".about-model")).toContainText("未测量");
  await expect(page.locator(".agh-logo")).toHaveCount(1);
  expect(
    await page
      .locator(".about-page")
      .evaluate((element) => getComputedStyle(element).overflowY !== "hidden"),
  ).toBe(true);
  for (const card of await page.locator(".about-page .card").all()) {
    const bounds = await card.evaluate((element) => ({
      name: element.className,
      scroll: element.scrollHeight,
      height: element.clientHeight,
    }));
    expect(bounds.scroll, bounds.name).toBeLessThanOrEqual(bounds.height + 1);
  }
  const sizes = await page.evaluate(() => ({
    project: document.querySelector(".about-logo")!.getBoundingClientRect()
      .width,
    agh: document.querySelector(".agh-logo")!.getBoundingClientRect().width,
  }));
  expect(sizes.project).toBeGreaterThan(sizes.agh * 4);
  for (const image of await page.locator(".about-page img").all())
    expect(
      await image.evaluate(
        (element) => (element as HTMLImageElement).naturalWidth,
      ),
    ).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("about-grid.png") });
  expect(errors).toEqual([]);
});
