import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { scheduleFixture } from "./agent-schedule-fixture";
const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
const version = { api_version: "1.0", timezone: "Asia/Shanghai" };
const record = {
  id: "shared",
  version: 1,
  start_at: "2026-10-12T02:00:00+08:00",
  end_at: "2026-10-12T04:00:00+08:00",
  start_ms: Date.parse("2026-10-12T02:00:00+08:00"),
  end_ms: Date.parse("2026-10-12T04:00:00+08:00"),
  hvac_setpoint_c: 26.2,
  storage_mode: "charge",
  storage_power_kw: 40,
  operator_id: "值班甲",
  reason: "人工核对完成",
  status: "manual",
  record_status: "active",
  cancelled_ms: null,
  source_key: "DO-NOT-SHOW",
  export_sha256: "HASH-PRIVATE",
};
async function open(page: any) {
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T02:00");
  await expect(page.getByText("数据加载中…", { exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await page.getByRole("button", { name: /Agent 决策/ }).click();
}
test("visible tabs poll active shared state; focus/hour immediately refresh", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  let active: any = null;
  const reads: { hour: number; at: number }[] = [];
  await context.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/schedule"))
      return r.fulfill({
        json: scheduleFixture(
          data,
          Number(r.request().postDataJSON().start.slice(11, 13)),
          active,
        ),
      });
    if (u.pathname.endsWith("/takeover/active")) {
      const hour = Number(u.searchParams.get("hour"));
      reads.push({ hour, at: Date.now() });
      return r.fulfill({ json: { ...version, takeover: active } });
    }
    if (u.pathname.endsWith("/recommendation"))
      return r.fulfill({
        json: { ...version, available: false, message: "推荐不可用" },
      });
    return r.abort();
  });
  const a = await context.newPage(),
    b = await context.newPage();
  try {
    await open(a);
    await open(b);
    await expect(
      a.getByRole("button", { name: "人工接管", exact: true }),
    ).toBeEnabled();
    await expect(
      b.getByRole("button", { name: "人工接管", exact: true }),
    ).toBeEnabled();
    const before = reads.length;
    active = record;
    await a.reload();
    await a.getByRole("button", { name: /Agent 决策/ }).click();
    await b.reload();
    await b.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(a.locator(".agent-takeover-banner")).toContainText(
      "人工接管中",
      { timeout: 6500 },
    );
    await expect(b.locator(".agent-takeover-banner")).toContainText(
      "人工接管中",
      { timeout: 6500 },
    );
    expect(reads.length).toBeGreaterThan(before);
    await expect(a.locator(".agent-takeover-banner")).toContainText(
      "02:00–04:00",
    );
    await expect(a.locator(".agent-takeover-banner")).not.toContainText(
      "+08:00",
    );
    await expect(a.locator(".agent-plan")).toContainText("26.2");
    await expect(a.locator(".agent-plan")).toContainText("充电 40");
    await expect(a.locator(".agent-decision-source")).toHaveText("人工配置");
    const count = reads.length;
    await a.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => reads.length).toBeGreaterThan(count);
    active = { ...record, record_status: "expired" };
    await a.getByRole("slider", { name: "24 小时时间轴" }).press("ArrowRight");
    await expect.poll(() => reads.at(-1)?.hour).toBe(3);
    await expect(a.locator(".agent-takeover-banner")).toHaveCount(0);
    // The shared timeline may synchronize the display hour in the other tab too.
    active = record;
    await a.getByRole("slider", { name: "24 小时时间轴" }).press("ArrowLeft");
    await expect(a.locator(".agent-takeover-banner")).toContainText(
      "人工接管中",
    );
    await expect(a.locator(".agent-root")).not.toContainText("DO-NOT-SHOW");
  } finally {
    await context.close();
  }
});
for (const width of [1366, 390])
  test.describe(`server records ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 768 } });
    test("manual BA/EMS receipt and both history tabs expose controls, not provenance or site acknowledgements", async ({
      page,
    }) => {
      await page.addInitScript(() =>
        sessionStorage.setItem("yunqi-takeover-operator-v1", "本标签值班员"),
      );
      let receiptQuery: any;
      await page.route("**/api/**", (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith("/schedule"))
          return r.fulfill({ json: scheduleFixture(data, 2, record) });
        if (u.pathname.endsWith("/takeover/active"))
          return r.fulfill({ json: { ...version, takeover: record } });
        if (u.pathname.endsWith("/recommendation"))
          return r.fulfill({
            json: { ...version, available: false, message: "推荐不可用" },
          });
        if (u.pathname.endsWith("/receipt")) {
          receiptQuery = Object.fromEntries(u.searchParams);
          return r.fulfill({
            json: {
              ...version,
              source: "manual",
              source_key: "DO-NOT-SHOW",
              export_sha256: "HASH-PRIVATE",
              records: [
                {
                  destination: "BA",
                  command: { setpoint_c: 26.2 },
                  effective: false,
                  created_at: "2026-10-11T18:03:00Z",
                },
                {
                  destination: "EMS",
                  command: { battery_kw: -40 },
                  effective: true,
                  created_at: "2026-10-11T18:02:00Z",
                },
              ],
              receipt: { count: 2, elapsed_ms: 1.6 },
            },
          });
        }
        if (u.pathname.endsWith("/history"))
          return r.fulfill({
            json: {
              ...version,
              items: [
                {
                  ...record,
                  id: "old",
                  status: "cancelled",
                  created_at: "2026-10-11T18:00:00Z",
                  cancelled_at: "2026-10-11T18:01:00Z",
                },
                {
                  ...record,
                  id: "new",
                  status: "active",
                  created_at: "2026-10-11T18:04:00Z",
                  cancelled_at: null,
                },
              ],
            },
          });
        if (u.pathname.endsWith("/audit"))
          return r.fulfill({
            json: {
              ...version,
              items: [
                {
                  id: 1,
                  occurred_at: "2026-10-12T01:00:00+08:00",
                  operator_id: "本标签值班员",
                  action: "cancel",
                  before: record,
                  after: {
                    ...record,
                    storage_mode: "idle",
                    storage_power_kw: 0,
                    reason: "取消配置",
                  },
                  source_key: "DO-NOT-SHOW",
                },
              ],
            },
          });
        return r.abort();
      });
      await open(page);
      await expect(page.locator(".agent-takeover-banner")).toBeVisible();
      await page.getByRole("button", { name: "查看执行回执" }).click();
      const dialog = page.getByRole("dialog", {
        name: "执行回执",
        exact: true,
      });
      await expect(dialog).toContainText("指令已写入调度记录");
      await expect(dialog).toContainText("BA：设定 26.2 °C");
      await expect(dialog).toContainText("EMS：充电 40.0 kW");
      await expect(dialog).toContainText("已失效的历史指令");
      expect(receiptQuery).toEqual({
        date: "2026-10-12",
        hour: "2",
        operator_id: "本标签值班员",
      });
      await expect(dialog.getByRole("textbox", { name: "操作人" })).toHaveCount(
        0,
      );
      await expect(dialog).not.toContainText("0.0 s");
      await expect(
        dialog.locator(".agent-server-receipt li").first(),
      ).toContainText("02:02 写入 · EMS");
      await expect(
        dialog.locator(".agent-server-receipt li").last(),
      ).toHaveClass("agent-receipt-inactive");
      await expect(dialog.locator("h3")).toHaveClass("type-title");
      await expect(dialog.locator("h3")).toHaveCSS("font-size", "18px");
      await expect(dialog.locator(".agent-receipt-inactive")).toHaveCSS(
        "color",
        "rgb(162, 180, 192)",
      );
      await expect(dialog).not.toContainText("现场已确认");
      await expect(dialog).not.toContainText("DO-NOT-SHOW");
      await expect(dialog).not.toContainText("HASH-PRIVATE");
      await dialog.getByRole("button", { name: "关闭" }).click();
      await page.getByRole("button", { name: "接管历史与日志" }).click();
      const logs = page.getByRole("dialog", { name: "接管记录与日志" });
      await expect(logs).toContainText("人工核对完成");
      await expect(logs).toContainText("已撤销");
      await expect(logs.locator("article").first()).toContainText(
        "建立：02:04 · 撤销：未撤销",
      );
      await expect(logs.locator("article").last()).toContainText(
        "建立：02:00 · 撤销：02:01",
      );
      await expect(logs.locator("h3")).toHaveClass("type-title");
      await expect(logs.locator("h3")).toHaveCSS("font-size", "18px");
      await logs.getByRole("tab", { name: "操作日志" }).click();
      await expect(logs).toContainText("撤销接管");
      await expect(logs).toContainText("操作前：温控 26.2 °C");
      await expect(logs).toContainText("取消配置");
      await expect(logs).not.toContainText("DO-NOT-SHOW");
      await expect(logs).not.toContainText("HASH-PRIVATE");
    });
    test("agent receipt reads actions only after operator input, unavailable endpoint never fabricates a static receipt", async ({
      page,
    }) => {
      let fail = true;
      await page.route("**/api/**", (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith("/schedule"))
          return r.fulfill({ json: scheduleFixture(data, 2) });
        if (u.pathname.endsWith("/takeover/active"))
          return r.fulfill({ json: { ...version, takeover: null } });
        if (u.pathname.endsWith("/recommendation"))
          return r.fulfill({
            json: { ...version, available: false, message: "推荐不可用" },
          });
        if (u.pathname.endsWith("/receipt"))
          return fail
            ? r.fulfill({ status: 503, json: { detail: "回执暂不可用" } })
            : r.fulfill({
                json: {
                  ...version,
                  source: "agent",
                  actions: ["BA：设定 25.5 °C", "EMS：待机"],
                  receipt: { count: 2 },
                  source_key: "DO-NOT-SHOW",
                },
              });
        return r.abort();
      });
      await open(page);
      await page.getByRole("button", { name: "查看执行回执" }).click();
      const dialog = page.getByRole("dialog", {
        name: "执行回执",
        exact: true,
      });
      await dialog.getByLabel("操作人").fill("值班乙");
      await dialog.getByRole("button", { name: "查询回执" }).click();
      await expect(dialog.getByRole("alert")).toContainText("回执暂不可用");
      await expect(dialog.locator(".agent-server-receipt")).toHaveCount(0);
      fail = false;
      await dialog.getByRole("button", { name: "重试" }).click();
      await expect(dialog).toContainText("Agent 指令");
      await expect(dialog).toContainText("BA：设定 25.5 °C");
      await expect(dialog).toContainText("EMS：待机");
      await expect(dialog.locator("li").first()).toContainText(
        "时间暂无数据 写入",
      );
      await dialog.getByRole("button", { name: "关闭" }).click();
      await page.getByRole("button", { name: "查看执行回执" }).click();
      await expect(dialog.getByRole("textbox", { name: "操作人" })).toHaveCount(
        0,
      );
      await expect(
        dialog.getByRole("button", { name: "查询回执" }),
      ).toHaveCount(0);
      await expect(dialog).toContainText("Agent 指令");
      await expect(dialog).not.toContainText("DO-NOT-SHOW");
    });
  });

for (const lifecycle of ["expired", "cancelled"] as const)
  test(`record_status ${lifecycle} overrides manual alias, never shows manual plan after 2 seconds or reload`, async ({
    page,
  }) => {
    const lifecycleRecord = {
      ...record,
      record_status: lifecycle,
      cancelled_at: lifecycle === "cancelled" ? "2026-10-11T18:58:00Z" : null,
      cancelled_by: "撤销乙",
    };
    await page.route("**/api/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/schedule"))
        return route.fulfill({ json: scheduleFixture(data, 2) });
      if (u.pathname.endsWith("/takeover/active"))
        return route.fulfill({
          json: { ...version, takeover: lifecycleRecord },
        });
      if (u.pathname.endsWith("/takeover/history"))
        return route.fulfill({
          json: { ...version, items: [lifecycleRecord] },
        });
      if (u.pathname.endsWith("/recommendation"))
        return route.fulfill({ json: { ...version, available: false } });
      return route.abort();
    });
    const inspect = async () => {
      await expect(page.locator(".agent-root")).not.toContainText("人工接管中");
      await expect(page.locator(".agent-decision-source")).not.toHaveText(
        "人工配置",
      );
      if (lifecycle === "expired")
        await expect(page.locator(".agent-takeover-banner")).toHaveCount(0);
      else
        await expect(page.locator(".agent-takeover-cancelled")).toHaveText(
          "本小时人工接管已撤销 · 02:58 · 操作人 撤销乙",
        );
    };
    await open(page);
    await inspect();
    await page.waitForTimeout(2200);
    await inspect();
    await page.reload();
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await inspect();
  });
