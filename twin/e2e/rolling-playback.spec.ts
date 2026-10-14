import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
test.use({ timezoneId: "Asia/Shanghai" });
for (const [at, route] of [
  ["2026-10-12T22:00", "normal"],
  ["2026-10-10T22:00", "normal"],
  ["2026-10-17T22:00", "abstain"],
  ["2026-07-23T22:00", "peak"],
])
  test(`hidden date selects ${route} without controls: ${at}`, async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (r) => {
      if (
        /\/replay\/(normal|peak|abstain)\.json$/.test(new URL(r.url()).pathname)
      )
        requested.push(new URL(r.url()).pathname.split("/").pop()!);
    });
    await page.route("**/api/**", (r) => r.abort());
    await page.goto(`/?source=file&at=${at}`);
    await expect(page.locator(".overview-number")).toHaveCount(3);
    await expect.poll(() => requested).toEqual([`${route}.json`]);
    await expect(page.locator(".day-switch")).toHaveCount(0);
    await expect(page.locator("header")).not.toContainText(
      /典型日|工作日|高温日|节假日/,
    );
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "22");
    await expect(
      page.getByRole("button", { name: "▶ 播放", exact: true }),
    ).toBeVisible();
  });
for (const width of [390, 1366])
  test(`22 to next-day 22 wraps and resets with pinned data ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await page.clock.install({ time: new Date("2026-10-12T22:00:00+08:00") });
    await page.clock.pauseAt(new Date("2026-10-12T22:00:00+08:00"));
    const requested: string[] = [];
    let schedules = 0;
    page.on("request", (r) => {
      if (
        /\/replay\/(normal|peak|abstain)\.json$/.test(new URL(r.url()).pathname)
      )
        requested.push(new URL(r.url()).pathname.split("/").pop()!);
    });
    await page.route("**/api/**", (r) => {
      if (r.request().url().endsWith("/schedule")) schedules++;
      return r.abort();
    });
    const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
    await page.goto("/?source=file&at=2026-10-12T22:00");
    await expect(page.locator(".overview-number")).toHaveCount(3);
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-12 周一 22:00:00",
    );
    await page
      .getByRole("button", { name: "预测与风险", exact: false })
      .click();
    await expect(page.locator(".forecast-root")).toHaveAttribute(
      "data-current-t",
      data.hours[22].t,
    );
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await expect(page.locator(".timeline-date-label")).toHaveText("10-12");
    await expect(page.locator(".timeline [data-hour]")).toHaveCount(24);
    const initialSchedules = schedules;
    await page.clock.fastForward(2000);
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-13 周二 00:00:00",
    );
    await expect(page.getByLabel("当前本地日期")).toHaveText("2026-10-13 周二");
    await expect(page.locator(".timeline-date-label")).toHaveText("10-13");
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "0");
    await expect(page.locator(".timeline")).toHaveAttribute(
      "data-day-offset",
      "1",
    );
    await expect(page.locator(".forecast-root")).toHaveAttribute(
      "data-current-t",
      data.hours[0].t,
    );
    await page.clock.fastForward(6000);
    await expect(page.locator(".forecast-root")).toHaveAttribute(
      "data-current-t",
      data.hours[6].t,
    );
    await page.clock.fastForward(16016);
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-13 周二 22:00:00",
    );
    await expect(page.locator(".timeline")).toHaveAttribute(
      "data-elapsed-hours",
      "24",
    );
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "22");
    await expect(
      page.getByRole("button", { name: "↺ 重置", exact: true }),
    ).toBeVisible();
    await page.clock.fastForward(3000);
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-13 周二 22:00:00",
    );
    expect(requested).toEqual(["normal.json"]);
    expect(schedules).toBe(initialSchedules);
    await page.getByRole("button", { name: "↺ 重置", exact: true }).click();
    await expect(page.getByLabel("当前本地时间")).toHaveText(
      "2026-10-12 周一 22:00:00",
    );
    await expect(
      page.getByRole("button", { name: "▶ 播放", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".timeline-date-label")).toHaveText("10-12");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("unfrozen reset resumes real seconds rather than the completed date", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-12T22:00:00+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T22:00:00+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file");
  await expect(page.locator(".overview-number")).toHaveCount(3);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.clock.fastForward(24016);
  await expect(
    page.getByRole("button", { name: "↺ 重置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "↺ 重置", exact: true }).click();
  await expect(page.getByLabel("当前本地日期")).toHaveText("2026-10-12 周一");
  const before = await page.getByLabel("当前本地时间").innerText();
  await page.clock.fastForward(1000);
  await expect(page.getByLabel("当前本地时间")).not.toHaveText(before);
});
