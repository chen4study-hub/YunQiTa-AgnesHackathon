import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { scheduleFixture } from "./agent-schedule-fixture";
const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
const version = { api_version: "1.0", timezone: "Asia/Shanghai" };
const recommendation = {
  ...version,
  available: true,
  hvac_setpoint_c: 25.6,
  storage_mode: "idle",
  storage_power_kw: 0,
  duration_hours: 3,
  reason: "模型推荐原文",
  recommendation_hash: "hash-current",
};
const record = {
  id: "takeover-test",
  version: 1,
  start_at: "2026-10-12T14:00:00+08:00",
  end_at: "2026-10-12T17:00:00+08:00",
  start_ms: Date.parse("2026-10-12T14:00:00+08:00"),
  end_ms: Date.parse("2026-10-12T17:00:00+08:00"),
  hvac_setpoint_c: 25.6,
  storage_mode: "idle",
  storage_power_kw: 0,
  operator_id: "值班甲",
  reason: "模型推荐原文",
  status: "active",
};
async function open(page: any) {
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await expect(page.getByText("数据加载中…", { exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await page.getByRole("button", { name: /Agent 决策/ }).click();
}
for (const width of [1366, 390])
  test.describe(`takeover ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 768 } });
    test("recommended placeholders submit exact defaults/hash, backend success overlays card, cancel is versioned; active survives reload", async ({
      page,
    }) => {
      let active: any = null;
      let cancelled: any = null;
      const posts: any[] = [];
      await page.route("**/api/**", async (r) => {
        const u = new URL(r.request().url());
        if (u.pathname === "/api/schedule")
          return r.fulfill({ json: scheduleFixture(data, 14, active) });
        if (u.pathname === "/api/takeover/history")
          return r.fulfill({
            json: { ...version, items: cancelled ? [cancelled] : [] },
          });
        if (u.pathname === "/api/takeover/active")
          return r.fulfill({ json: { ...version, takeover: active } });
        if (u.pathname === "/api/takeover/recommendation") {
          expect(u.searchParams.get("date")).toBe("2026-10-12");
          expect(u.searchParams.get("hour")).toBe("14");
          return r.fulfill({ json: recommendation });
        }
        if (u.pathname === "/api/takeover") {
          const b = r.request().postDataJSON();
          posts.push(b);
          active = { ...record, ...b };
          return r.fulfill({ json: { ...version, takeover: active } });
        }
        if (u.pathname === "/api/takeover/takeover-test/cancel") {
          posts.push(r.request().postDataJSON());
          cancelled = {
            ...record,
            status: "cancelled",
            version: 2,
            cancelled_at: "2026-10-12T06:58:00Z",
            cancelled_by: "撤销值班乙",
          };
          active = null;
          return r.fulfill({
            json: {
              ...version,
              takeover: { ...record, status: "cancelled", version: 2 },
            },
          });
        }
        return r.abort();
      });
      await open(page);
      const take = page.getByRole("button", { name: "人工接管", exact: true });
      await expect(take).toBeEnabled();
      await take.click();
      const dialog = page.getByRole("dialog", { name: "人工接管配置" });
      await expect(dialog).toBeVisible();
      const panelMetrics = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          overflow: getComputedStyle(el).overflowY,
          buttons: [...el.querySelectorAll("button")].map((b) => ({
            w: b.getBoundingClientRect().width,
            h: b.getBoundingClientRect().height,
          })),
        };
      });
      expect(panelMetrics.left).toBeGreaterThanOrEqual(0);
      expect(panelMetrics.right).toBeLessThanOrEqual(width);
      expect(panelMetrics.top).toBeGreaterThanOrEqual(0);
      expect(panelMetrics.bottom).toBeLessThanOrEqual(
        width === 390 ? 844 : 768,
      );
      expect(panelMetrics.overflow).toBe("auto");
      expect(panelMetrics.buttons.every((b) => b.w >= 36 && b.h >= 36)).toBe(
        true,
      );
      await expect(dialog.getByLabel("持续小时")).toHaveValue("3");
      await expect(dialog.getByLabel("设定温度（°C）")).toHaveValue("25.6");
      await expect(dialog.getByLabel("储能模式")).toHaveValue("idle");
      await expect(dialog.getByLabel("持续小时")).toHaveAttribute(
        "placeholder",
        "推荐 3",
      );
      await expect(dialog.getByLabel("设定温度（°C）")).toHaveAttribute(
        "placeholder",
        "推荐 25.6",
      );
      await expect(dialog.locator(".agent-takeover-idle")).toHaveText(
        "待机，不下发功率",
      );
      await expect(dialog.getByLabel("原因", { exact: true })).toHaveAttribute(
        "placeholder",
        "模型推荐原文",
      );
      await dialog.getByLabel("操作人", { exact: true }).fill("值班甲");
      await dialog.getByRole("button", { name: "提交接管" }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator(".agent-takeover-banner")).toContainText(
        "人工接管中",
      );
      await expect(page.locator(".agent-takeover-banner")).toContainText(
        "14:00–17:00 · 操作人 值班甲",
      );
      await expect(page.locator(".agent-status-bar")).toBeHidden();
      const banner = page.locator(".agent-takeover-banner");
      await banner.scrollIntoViewIfNeeded();
      const geometry = await banner.evaluate((e) => {
        const r = e.getBoundingClientRect(),
          b = e.querySelector("button")!.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          w: b.width,
          h: b.height,
          scroll: e.scrollWidth,
          client: e.clientWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.w).toBeGreaterThanOrEqual(36);
      expect(geometry.h).toBeGreaterThanOrEqual(36);
      await expect(page.locator(".agent-actions button")).toHaveText([
        "查看执行回执",
      ]);
      expect(
        (await page.locator(".agent-decision-card").innerText()).match(
          /人工接管中/g,
        ),
      ).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        date: "2026-10-12",
        hour: 14,
        duration_hours: 3,
        hvac_setpoint_c: 25.6,
        storage_mode: "idle",
        storage_power_kw: 0,
        reason: "模型推荐原文",
        operator_id: "值班甲",
        recommendation_hash: "hash-current",
      });
      expect(posts[0].request_id).toBeTruthy();
      await expect(page.locator(".agent-plan")).toContainText("25.6");
      await expect(page.locator(".agent-decision-source")).toHaveText(
        "人工配置",
      );
      await expect(page.locator(".agent-reason-section")).toContainText(
        "模型推荐原文",
      );
      await page.reload();
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(page.locator(".agent-takeover-banner")).toContainText(
        "人工接管中",
      );
      await page.getByRole("button", { name: "撤销接管" }).click();
      await page
        .locator(".agent-takeover-cancel")
        .getByRole("textbox", { name: "撤销原因", exact: true })
        .fill("结束人工接管");
      await expect(
        page
          .locator(".agent-takeover-cancel")
          .getByRole("textbox", { name: "撤销操作人", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "确认撤销" }).click();
      await expect(page.locator(".agent-takeover-cancelled")).toHaveText(
        "本小时人工接管已撤销 · 14:58 · 操作人 撤销值班乙",
      );
      await page.reload();
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(page.locator(".agent-takeover-cancelled")).toHaveText(
        "本小时人工接管已撤销 · 14:58 · 操作人 撤销值班乙",
      );
      expect(posts[1]).toMatchObject({
        operator_id: "值班甲",
        reason: "结束人工接管",
        expected_version: 1,
      });
    });
    test("unavailable recommendations do not fill zero; explicit values can submit and detail appears verbatim", async ({
      page,
    }) => {
      let posts = 0;
      await page.route("**/api/**", (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith("/active"))
          return r.fulfill({ json: { ...version, takeover: null } });
        if (u.pathname.endsWith("/recommendation"))
          return r.fulfill({
            json: { ...version, available: false, message: "该时段推荐不可用" },
          });
        if (u.pathname === "/api/takeover") {
          posts++;
          return r.fulfill({
            status: 409,
            json: { detail: "推荐已更新，请重新确认" },
          });
        }
        return r.abort();
      });
      await open(page);
      await expect(
        page.getByRole("button", { name: "人工接管", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "人工接管配置" });
      await expect(dialog).toContainText("该时段推荐不可用");
      for (const label of ["持续小时", "设定温度（°C）"]) {
        await expect(dialog.getByLabel(label)).toHaveValue("");
        await expect(dialog.getByLabel(label)).toHaveAttribute(
          "placeholder",
          "",
        );
      }
      await dialog.getByLabel("操作人", { exact: true }).fill("值班乙");
      await dialog.getByRole("button", { name: "提交接管" }).click();
      await expect(dialog).toContainText("请填写完整的有效配置");
      expect(posts).toBe(0);
      await dialog.getByLabel("持续小时").fill("2");
      await dialog.getByLabel("设定温度（°C）").fill("26.2");
      await dialog.getByLabel("储能模式").selectOption("discharge");
      await dialog.getByLabel("储能功率（kW）").fill("40");
      await dialog.getByLabel("原因", { exact: true }).fill("人工核对后调整");
      await dialog.getByRole("button", { name: "提交接管" }).click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "推荐已更新，请重新确认",
      );
      expect(posts).toBe(1);
      await expect(
        dialog.getByRole("button", { name: "提交接管" }),
      ).toBeEnabled();
    });
  });
for (const response of ["html", "unversioned"])
  test(`takeover ${response} fallback disables writes, never substitutes local success`, async ({
    page,
  }) => {
    await page.route("**/api/**", (r) =>
      r.request().url().includes("/takeover/")
        ? r.fulfill({
            contentType: response === "html" ? "text/html" : "application/json",
            body:
              response === "html"
                ? "<html>SPA</html>"
                : '{"takeover":null,"available":true}',
          })
        : r.abort(),
    );
    await open(page);
    await expect(
      page.getByRole("button", { name: "人工接管", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".agent-takeover-notice")).toContainText(
      "接管服务暂不可用，请稍后重试",
    );
  });

test("mobile panel tokens, recommendation markings, one-decimal power, scroll and operator session memory", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 540 });
  await page.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/active"))
      return r.fulfill({ json: { ...version, takeover: null } });
    if (u.pathname.endsWith("/recommendation"))
      return r.fulfill({
        json: {
          ...recommendation,
          storage_mode: "discharge",
          storage_power_kw: 199.9999000175467,
        },
      });
    return r.abort();
  });
  await open(page);
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "人工接管配置" });
  await expect(panel.getByLabel("设定温度（°C）")).toHaveAttribute(
    "placeholder",
    "推荐 25.6",
  );
  await expect(panel.getByLabel("储能功率（kW）")).toHaveAttribute(
    "placeholder",
    "推荐 200.0",
  );
  await panel.getByLabel("储能模式").selectOption("idle");
  await expect(panel.locator(".agent-takeover-idle")).toHaveText(
    "待机，不下发功率",
  );
  await expect(panel.locator('input[min="0"][max="500"]')).toHaveCount(0);
  await panel.getByLabel("储能模式").selectOption("charge");
  await expect(panel.getByLabel("储能功率（kW）")).toHaveAttribute(
    "placeholder",
    "推荐 200.0",
  );
  await panel.getByLabel("操作人", { exact: true }).fill("记住值班员");
  const sizes = await panel.evaluate((e) => ({
    width: e.getBoundingClientRect().width,
    height: e.getBoundingClientRect().height,
    scroll: e.scrollHeight,
    client: e.clientHeight,
    buttons: [...e.querySelectorAll("button")].map(
      (b) => b.getBoundingClientRect().height,
    ),
    title: getComputedStyle(e.querySelector("h3")!).fontSize,
    token: getComputedStyle(e).getPropertyValue("--font-title"),
  }));
  expect(parseFloat(sizes.title)).toBeGreaterThanOrEqual(18);
  await expect(panel.locator("h3")).toHaveClass("type-title");
  expect(sizes.width).toBeLessThanOrEqual(390);
  expect(sizes.height).toBeLessThanOrEqual(540);
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect(sizes.buttons.every((h) => h >= 36)).toBe(true);
  await panel
    .getByRole("button", { name: "提交接管" })
    .scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "提交接管" })).toBeVisible();
  await panel.getByRole("button", { name: "关闭" }).click();
  await page.reload();
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(
    page.getByRole("button", { name: "人工接管", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  panel = page.getByRole("dialog", { name: "人工接管配置" });
  await expect(panel.getByLabel("操作人", { exact: true })).toHaveValue(
    "记住值班员",
  );
});
