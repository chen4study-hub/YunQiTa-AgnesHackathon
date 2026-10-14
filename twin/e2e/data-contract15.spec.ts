import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
]) {
  test.describe(`data 1.5 ${viewport.width}`, () => {
    test.use({ viewport });
    test("failed main is explicit, retry recovers without fabricated data", async ({
      page,
    }) => {
      let fail = true;
      await page.route(
        (url) => url.pathname.endsWith("/replay/normal.json"),
        (r) =>
          fail ? r.fulfill({ status: 503, body: "unavailable" }) : r.continue(),
      );
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&at=2026-10-12T14:00");
      await expect(page.getByRole("alert")).toContainText("数据暂不可用");
      await expect(page.locator('[aria-label="页面内容"]')).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(
        await page
          .getByRole("alert")
          .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
      ).toBeGreaterThanOrEqual(14);
      fail = false;
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await page.getByRole("button", { name: "Agent 决策" }).click();
      const data = JSON.parse(
        readFileSync("public/replay/normal.json", "utf8"),
      );
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-origin",
        data.hours[14].t,
      );
    });
    test("no companion on initial load; requested ticket validates hash, reports mismatch, retries", async ({
      page,
    }) => {
      let calls = 0,
        broken = true;
      await page.route("**/api/**", (r) => r.abort());
      const detail = () => {
        const x = JSON.parse(
          readFileSync("public/replay/abstain.agent-detail.json", "utf8"),
        );
        if (broken) x.main_sha256 = "0".repeat(64);
        return Buffer.from(JSON.stringify(x));
      };
      // Exercise adapter main/companion identity checks, not device versioning.
      // A changing, intentionally invalid companion must not enter the cache;
      // the independent replay-device-cache spec covers manifest/SHA behavior.
      await page.route(
        (url) => url.pathname.endsWith("/data-manifest.json"),
        (r) => r.fulfill({ status: 404, body: "adapter fixture" }),
      );
      await page.route(
        (url) => url.pathname.endsWith("/replay/abstain.agent-detail.json"),
        (r) => {
          calls++;
          return r.fulfill({ body: detail(), contentType: "application/json" });
        },
      );
      await page.goto("/?source=file&at=2026-10-01T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-root")).toBeVisible();
      expect(calls).toBe(0);
      await page.getByRole("button", { name: "查看人工工单" }).click();
      await expect(
        page.getByRole("dialog", { name: "人工工单" }),
      ).toContainText("数据暂不可用");
      expect(calls).toBe(1);
      broken = false;
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "重试" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "人工工单" }),
      ).toContainText("建议检查");
      expect(calls).toBe(2);
    });
  });
}
test("all three validated main files render Forecast with real values and no detail request", async ({
  page,
}) => {
  let details = 0;
  page.on("request", (r) => {
    if (r.url().includes(".agent-detail.json")) details++;
  });
  await page.route("**/api/**", (r) => r.abort());
  for (const date of ["2026-10-12", "2026-07-23", "2026-10-01"]) {
    await page.goto(`/?source=file&at=${date}T14:00`);
    await page.getByRole("button", { name: /预测与风险/ }).click();
    await expect(page.locator(".forecast-root")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  expect(details).toBe(0);
});
