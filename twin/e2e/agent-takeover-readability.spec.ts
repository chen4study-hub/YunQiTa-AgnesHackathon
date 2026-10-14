import { test, expect, type Locator } from "@playwright/test";
const version = { api_version: "1.0", timezone: "Asia/Shanghai" };
async function checkDialog(dialog: Locator, width: number, height: number) {
  const m = await dialog.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      scroll: e.scrollHeight,
      client: e.clientHeight,
      overflow: getComputedStyle(e).overflowY,
      buttons: [...e.querySelectorAll("button")].map((b) => ({
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
      })),
    };
  });
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.right).toBeLessThanOrEqual(width);
  expect(m.bottom).toBeLessThanOrEqual(height);
  expect(m.scroll).toBeGreaterThan(m.client);
  expect(m.overflow).toBe("auto");
  expect(m.buttons.every((b) => b.w >= 36 && b.h >= 36)).toBe(true);
  await dialog.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  const bottom = await dialog.evaluate((e) => e.scrollTop + e.clientHeight);
  expect(bottom).toBeGreaterThanOrEqual(m.scroll - 1);
}
for (const width of [390, 1366])
  test(`long receipts/history remain readable and scrollable at ${width}`, async ({
    page,
  }, testInfo) => {
    const height = width === 390 ? 844 : 768;
    await page.setViewportSize({ width, height });
    await page.addInitScript(() =>
      sessionStorage.setItem("yunqi-takeover-operator-v1", "布局验收员"),
    );
    await page.route("**/api/**", (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith("/active"))
        return r.fulfill({ json: { ...version, takeover: null } });
      if (u.pathname.endsWith("/recommendation"))
        return r.fulfill({
          json: { ...version, available: false, message: "推荐暂不可用" },
        });
      if (u.pathname.endsWith("/receipt"))
        return r.fulfill({
          json: {
            ...version,
            source: "manual",
            records: Array.from({ length: 36 }, (_, i) => ({
              destination: i % 2 ? "EMS" : "BA",
              command: i % 2 ? { battery_kw: 200 } : { setpoint_c: 26.7 },
              effective: i < 2,
              created_at: "2026-10-12T06:02:00Z",
            })),
            receipt: { count: 36, elapsed_ms: 0 },
          },
        });
      if (u.pathname.endsWith("/history"))
        return r.fulfill({
          json: {
            ...version,
            items: Array.from({ length: 18 }, (_, i) => ({
              id: String(i),
              start_at: "2026-10-12T14:00:00+08:00",
              end_at: "2026-10-12T15:00:00+08:00",
              created_at: "2026-10-12T06:02:00Z",
              cancelled_at: "2026-10-12T06:03:00Z",
              operator_id: "布局验收员",
              status: "cancelled",
              hvac_setpoint_c: 26.7,
              storage_mode: "discharge",
              storage_power_kw: 200,
              reason: "核对较长历史记录是否能滚动并完整查看。".repeat(3),
            })),
          },
        });
      return r.abort();
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await page.getByRole("button", { name: "查看执行回执" }).click();
    const receipt = page.getByRole("dialog", { name: "执行回执", exact: true });
    await expect(receipt.locator("li")).toHaveCount(36);
    const fonts = await receipt
      .locator("li,li span")
      .evaluateAll((rows) =>
        rows.map((e) => parseFloat(getComputedStyle(e).fontSize)),
      );
    expect(fonts.every((f) => f >= 14)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-receipt-top.png`),
    });
    await checkDialog(receipt, width, height);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-receipt-bottom.png`),
    });
    await receipt.locator("li").last().scrollIntoViewIfNeeded();
    await expect(receipt.locator("li").last()).toBeInViewport();
    await receipt.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "接管历史与日志" }).click();
    const history = page.getByRole("dialog", { name: "接管记录与日志" });
    await expect(history.locator("article")).toHaveCount(18);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-history-top.png`),
    });
    await checkDialog(history, width, height);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-history-bottom.png`),
    });
    await history.getByRole("button", { name: "刷新" }).click();
    await expect(history.locator("article")).toHaveCount(18);
    await history.getByRole("button", { name: "关闭" }).click();
  });
