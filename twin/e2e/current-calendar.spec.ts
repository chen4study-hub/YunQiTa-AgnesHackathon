import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
test.use({ timezoneId: "Asia/Shanghai" });
for (const width of [390, 1366, 1920])
  test(`hidden route and local shell date, no scenario controls ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.route("**/api/**", (r) => r.abort());
    await page.goto("/?source=file&scenario=peak&at=2026-10-12T14:23:05");
    await expect(page.getByLabel("当前本地日期")).toHaveText("2026-10-12 周一");
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-12 周一 14:23:05",
    );
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "14");
    await expect(page.locator(".day-switch")).toHaveCount(0);
    await expect(page.locator("header")).not.toContainText(
      /典型日|工作日|高温日|节假日/,
    );
    expect(await page.locator("header button").count()).toBe(6);
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-12 周一 14:23:05",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    for (const selector of ["header", "footer"])
      expect(
        await page
          .locator(selector)
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
  });
for (const [at, route, date] of [
  ["2026-10-12T09:23:05", "normal", "2026-10-12 周一"],
  ["2026-07-23T14:00", "peak", "2026-07-23 周四"],
  ["2026-07-25T14:00", "abstain", "2026-07-25 周六"],
  ["2026-10-01T14:00", "abstain", "2026-10-01 周四 国庆节"],
  ["2026-10-10T14:00", "normal", "2026-10-10 周六"],
  ["2026-06-19T14:00", "abstain", "2026-06-19 周五 端午节"],
])
  test(`automatically requests ${route} on ${at}`, async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (r) => {
      if (
        /\/replay\/(normal|peak|abstain)\.json$/.test(new URL(r.url()).pathname)
      ) {
        expect(new URL(r.url()).searchParams.get("v")).toBe(
          createHash("sha256")
            .update(readFileSync(`public${new URL(r.url()).pathname}`))
            .digest("hex")
            .slice(0, 12),
        );
        requested.push(new URL(r.url()).pathname.split("/").pop()!);
      }
    });
    await page.route("**/api/**", (r) => r.abort());
    await page.goto(`/?source=file&at=${at}`);
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByLabel("当前本地日期")).toHaveText(date);
    await expect.poll(() => requested).toEqual([`${route}.json`]);
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".timeline")).toHaveAttribute(
      "data-time",
      String(+at.slice(11, 13)),
    );
  });
test("actual browser clock ticks seconds and updates hour at boundary, without playback", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-12T13:59:58+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T13:59:58+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file");
  await expect(page.getByLabel("当前本地时间")).toHaveText(
    "2026-10-12 周一 13:59:58",
  );
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "13");
  await page.clock.fastForward(1000);
  await expect(page.getByLabel("当前本地时间")).toHaveText(
    "2026-10-12 周一 13:59:59",
  );
  await page.clock.fastForward(1000);
  await expect(page.getByLabel("当前本地时间")).toHaveText(
    "2026-10-12 周一 14:00:00",
  );
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "14");
});
test("midnight updates calendar and automatically changes summer workday to holiday data", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (r) => {
    if (
      /\/replay\/(normal|peak|abstain)\.json$/.test(new URL(r.url()).pathname)
    ) {
      expect(new URL(r.url()).searchParams.get("v")).toBe(
        createHash("sha256")
          .update(readFileSync(`public${new URL(r.url()).pathname}`))
          .digest("hex")
          .slice(0, 12),
      );
      requested.push(new URL(r.url()).pathname.split("/").pop()!);
    }
  });
  await page.clock.install({ time: new Date("2026-06-18T23:59:59+08:00") });
  await page.clock.pauseAt(new Date("2026-06-18T23:59:59+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => requested).toEqual(["peak.json"]);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.clock.fastForward(1000);
  await expect(page.getByLabel("当前本地时间")).toHaveText(
    "2026-06-19 周五 端午节 00:00:00",
  );
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "0");
  await expect.poll(() => requested).toEqual(["peak.json", "abstain.json"]);
});
