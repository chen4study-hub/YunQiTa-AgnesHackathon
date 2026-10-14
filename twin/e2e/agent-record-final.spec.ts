import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { scheduleFixture } from "./agent-schedule-fixture";
for (const width of [1366, DESKTOP_125.width, 390])
  test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`online records ${width}: no receipt is not offline, absent source is quiet, storage is unsigned`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : DESKTOP_125.height });
    const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
    for (const hour of data.hours) delete hour.agent.source;
    await page.route("**/replay/normal.json", (r) => r.fulfill({ json: data }));
    let connected = true;
    await page.route("**/api/**", (r) => {
      const u = new URL(r.request().url());
      if (!connected) return r.abort();
      if (u.pathname.endsWith("/schedule"))
        return r.fulfill({ json: scheduleFixture(data, 3) });
      if (u.pathname.endsWith("/takeover/active"))
        return r.fulfill({
          json: {
            api_version: "1.0",
            timezone: "Asia/Shanghai",
            takeover: null,
          },
        });
      if (u.pathname.endsWith("/takeover/history"))
        return r.fulfill({
          json: { api_version: "1.0", timezone: "Asia/Shanghai", items: [] },
        });
      if (u.pathname.endsWith("/recommendation"))
        return r.fulfill({
          json: {
            api_version: "1.0",
            timezone: "Asia/Shanghai",
            available: false,
          },
        });
      return r.abort();
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-13T03:00");
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-request-status")).toHaveText(
      "当前时刻",
    );
    await expect(
      page.locator(".agent-decision-card .agent-heading"),
    ).not.toContainText("决策来源未提供");
    await expect(page.locator(".agent-plan li").last()).toContainText("待机 0");
    await expect(page.locator(".agent-plan li").last()).not.toContainText("-");
    if (width >= 1181)
      await page.getByRole("tab", { name: "近期记录（6 小时）" }).click();
    const rows = page.locator(".agent-record-card tbody tr");
    await expect(rows).toHaveCount(6);
    for (const hour of ["00:00", "01:00", "02:00"]) {
      const row = rows.filter({ hasText: hour }).first();
      await expect(row).toContainText("暂无回执");
      await expect(row).not.toContainText("需要连接后端");
      await expect(row).not.toContainText("人工工单");
    }
    await expect(page.locator(".agent-record-card")).not.toContainText(
      "kW · 充电",
    );
    await page.locator(".agent-record-card").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`${width}-online-records.png`),
    });
    connected = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(rows.filter({ hasText: "01:00" }).first()).toContainText(
      "需要连接后端",
    );
  });
  });
