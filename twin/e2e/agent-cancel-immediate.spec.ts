import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { currentUI4183 } from "./agent-local-ui-4183";
import { scheduleFixture } from "./agent-schedule-fixture";
test("fractional hour cancellation awaits a fresh schedule and shows execution without reload", async ({
  page,
}) => {
  await currentUI4183(page);
  const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8")),
    v = { api_version: "1.0", timezone: "Asia/Shanghai" };
  let record: any = {
      id: "fractional",
      version: 1,
      status: "active",
      start_at: "2026-10-13T14:00:00+08:00",
      end_at: "2026-10-13T15:00:00+08:00",
      start_ms: Date.parse("2026-10-13T14:00:00+08:00"),
      end_ms: Date.parse("2026-10-13T15:00:00+08:00"),
      operator_id: "甲",
      reason: "人工接管",
      hvac_setpoint_c: 26,
      storage_mode: "idle",
      storage_power_kw: 0,
    },
    cancelled: any = null,
    calls = 0;
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/api/schedule") {
      calls++;
      const response = scheduleFixture(data, 14, record);
      response.receipt = { count: record ? 0 : 2 };
      await new Promise((r) => setTimeout(r, 150));
      return r.fulfill({ json: response });
    }
    if (path === "/api/takeover/active")
      return r.fulfill({ json: { ...v, takeover: record ?? cancelled } });
    if (path === "/api/takeover/history")
      return r.fulfill({ json: { ...v, items: cancelled ? [cancelled] : [] } });
    if (path === "/api/takeover/recommendation")
      return r.fulfill({ json: { ...v, available: false } });
    if (path === "/api/takeover/fractional/cancel") {
      cancelled = {
        ...record,
        status: "cancelled",
        cancelled_at: "2026-10-13T06:58:00Z",
        cancelled_ms: Date.parse("2026-10-13T06:58:00Z"),
        cancelled_by: "甲",
      };
      record = null;
      return r.fulfill({ json: { ...v, takeover: cancelled } });
    }
    return r.abort();
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(page.locator(".agent-decision-source")).toHaveText("人工配置");
  const slider = page.getByRole("slider", { name: "24 小时时间轴" }),
    b = (await slider.boundingBox())!;
  await page.mouse.move(b.x + (b.width * 14.4) / 24, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + (b.width * 14.6) / 24, b.y + b.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")) % 1)
    .toBeGreaterThan(0);
  const before = calls;
  await page.getByRole("button", { name: "撤销接管", exact: true }).click();
  await page.getByLabel("撤销原因", { exact: true }).fill("恢复自动");
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(page.locator(".agent-status-bar")).toContainText(
    "已自动下发 · 执行中",
  );
  expect(calls).toBe(before + 1);
  await expect(page.locator(".agent-takeover-cancelled")).toContainText(
    "本小时人工接管已撤销",
  );
  await expect(page.locator(".agent-decision-source")).not.toHaveText(
    "人工配置",
  );
});
