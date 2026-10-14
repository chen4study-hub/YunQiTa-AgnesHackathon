import { test, expect } from "@playwright/test";

test("K02 components at 1920 × 1080", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (/fonts\.googleapis|fonts\.gstatic/.test(request.url()))
      fontRequests.push(request.url());
  });
  await page.goto("/showcase.html");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "环境与人员" })).toBeVisible();
  await expect(
    page
      .getByRole("img", { name: "24 小时预测、区间与实测曲线" })
      .locator("canvas"),
  ).toBeVisible();
  await expect(page.getByText("LIVE · 已接入")).toHaveCount(8);
  await expect(page.locator("body")).not.toContainText(
    /演示|模拟|估算|影子模式/,
  );
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    })),
  ).toEqual({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "查看执行回执" }).click();
  await expect(page.getByRole("status")).toHaveText("执行回执已展开");
  await page.getByRole("button", { name: "10:00", exact: true }).click();
  await expect(page.locator(".clock")).toContainText("10:00");
  await page.getByRole("button", { name: "14:00", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.screenshot({ path: info.outputPath("interactions.png") });
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath("k02-1920x1080.png") });
  for (const [name, selector] of [
    ["topbar", ".topbar"],
    ["bottombar", ".bottombar"],
    ["metrics", ".summary-column"],
    ["source-values", ".environment-card"],
    ["corner", ".sources-card"],
    ["table", ".alarm-card"],
    ["buttons", ".actions"],
    ["chart", ".forecast-card"],
  ]) {
    await page
      .locator(selector)
      .screenshot({ path: info.outputPath(`k02-${name}.png`) });
  }
  expect(errors).toEqual([]);
  expect(fontRequests).toEqual([]);
});
