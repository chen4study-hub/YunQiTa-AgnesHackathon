import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));

const notes = [
  "人工接管和指令记录写入后端数据库，当前部署未接入现场设备。",
  "超出楼宇数据范围的问题，会通过公开的百科和搜索服务查询，问题原文会发送给这些服务。",
  "运维问答由服务端调用模型和工具回答，服务不可用时用已核验的工具结果回答。",
];
for (const size of [
  { width: 1366, height: 768 },
  DESKTOP_125,
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`About system notes retain normal spacing ${size.width}x${size.height}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(size);
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/?source=file");
    await page.getByRole("button", { name: "关于", exact: false }).click();
    const about = page.locator(".about-page");
    await expect(about).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    for (const note of notes)
      await expect(
        page.locator(".about-architecture .about-access"),
      ).toContainText(note);
    await expect(about).not.toContainText(
      /典型日|情景|代表日|回放|游标|模拟|估算|估计|推算|沿用|非实测|演示|影子模式|待人工确认/,
    );
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: size.width, height: size.height });
    for (const card of await about.locator(":scope > .card").all())
      expect(
        await card.evaluate((el) => ({
          overflow: getComputedStyle(el).overflowY,
          clipped: el.scrollHeight > el.clientHeight + 1,
        })),
      ).toEqual({ overflow: "visible", clipped: false });
    expect(
      await page
        .locator(".about-access")
        .evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.previousElementSibling!.getBoundingClientRect().bottom,
        ),
    ).toBeCloseTo(12, 1);
  });
  });
}
