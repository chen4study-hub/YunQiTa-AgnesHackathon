import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const replay = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
const reason =
  "调度接口原文：按当前区间上界准备，综合电费、设备约束与储能状态选择已校验方案。".repeat(
    100,
  );
for (const width of [1366, 1920, 390]) {
  test(`Agent ${width}: long schedule reason and value hierarchy`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width,
      height: width === 1366 ? 768 : width === 390 ? 844 : 1080,
    });
    await page.route("**/api/**", async (route) => {
      if (!route.request().url().endsWith("/schedule")) return route.abort();
      const body = route.request().postDataJSON();
      const h = replay.hours.find((h: { t: string }) => h.t === body.start);
      const command = {
        timestamp: h.t,
        hvac_setpoint_c: 25.5,
        battery_kw: 0,
        prepared_upper_kw: h.upper_kw,
        action: "hold",
      };
      return route.fulfill({
        json: {
          building_id: replay.meta.building_id,
          plan: [command],
          candidates: [
            {
              candidate_id: "rule_full",
              plan: [command],
              simulation: { estimated_cost: 321.4, estimated_peak_kw: 456.7 },
            },
          ],
          selected: "rule_full",
          reason,
          needs_human: false,
          work_orders: [],
          receipt: {
            count: 2,
            elapsed_ms: 1.234,
            transport: "log_only",
            device_connected: false,
          },
        },
      });
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await page.getByRole("button", { name: "Agent 决策" }).click();
    await expect(page.locator(".agent-root")).toHaveAttribute(
      "data-decision-source",
      "schedule",
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    const metrics = await page.locator(".agent-plan ul li").evaluateAll((es) =>
      es.map((e) => {
        const label = e.querySelector(".agent-plan-label")!,
          value = e.querySelector(".smooth-value")!,
          unit = e.querySelector("small")!;
        const l = label.getBoundingClientRect(),
          v = value.getBoundingClientRect(),
          u = unit.getBoundingClientRect();
        return {
          above: l.bottom <= v.top + 2,
          gap: u.left - v.right,
          numberSize: parseFloat(getComputedStyle(value).fontSize),
          unitSize: parseFloat(getComputedStyle(unit).fontSize),
          fits: e.scrollWidth <= e.clientWidth + 1,
        };
      }),
    );
    for (const m of metrics) {
      expect(m.above).toBe(true);
      expect(m.gap).toBeLessThanOrEqual(10);
      expect(m.numberSize).toBeGreaterThanOrEqual(16);
      expect(m.unitSize).toBeGreaterThanOrEqual(11);
      expect(m.fits).toBe(true);
    }
    await assertShellScrolling(page, "long reason readability");
    await page.getByRole("button", { name: "展开调度理由" }).click();
    const dialog = page.getByRole("dialog", { name: "完整调度理由" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("p")).toHaveText(reason);
    const geometry = await dialog.evaluate((e) => ({
      top: e.getBoundingClientRect().top,
      bottom: e.getBoundingClientRect().bottom,
      scroll:
        e.querySelector(".agent-reason-full")!.scrollHeight >
        e.querySelector(".agent-reason-full")!.clientHeight,
    }));
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(
      width === 1366 ? 768 : width === 390 ? 844 : 1080,
    );
    expect(geometry.scroll).toBe(true);
    await dialog.getByRole("button", { name: "关闭" }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "展开调度理由" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
}

for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`handoff full reason ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("long refused schedule reason fits page and remains complete in modal", async ({
      page,
    }) => {
      const data = JSON.parse(
        readFileSync("public/replay/abstain.json", "utf8"),
      );
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/schedule")) return route.abort();
        const h = data.hours.find(
          (h: { t: string }) => h.t === route.request().postDataJSON().start,
        );
        const command = {
          timestamp: h.t,
          hvac_setpoint_c: 25.5,
          battery_kw: 0,
          action: "human_review",
        };
        return route.fulfill({
          json: {
            building_id: data.meta.building_id,
            source: "rule",
            explanation_source: "template",
            plan: [command],
            candidates: [{ candidate_id: "rule_hold", plan: [command] }],
            selected: "rule_hold",
            reason,
            needs_human: true,
          },
        });
      });
      await page.goto("/?source=file&scenario=abstain&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-decision-source",
        "schedule",
      );
      await page.waitForTimeout(350);
      await assertShellScrolling(page, "handoff reason readability");
      await page.getByRole("button", { name: "展开调度理由" }).click();
      const dialog = page.getByRole("dialog", { name: "完整调度理由" });
      await expect(dialog.locator(".agent-reason-full")).toHaveText(reason);
      const rect = await dialog.boundingBox();
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(size.height);
      expect(
        await dialog
          .locator(".agent-reason-full")
          .evaluate((e) => e.scrollHeight > e.clientHeight),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    });
  });
  });

test("390 chat expanded process and long answer remain readable inside a content-sized card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const answer = "查询结果仅依据当前工具记录，请核对设备与表计状态。".repeat(
    100,
  );
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().endsWith("/chat/stream")) return route.abort();
    const events: unknown[] = [];
    for (let i = 0; i < 20; i++)
      events.push({ type: "step", text: `核对步骤 ${i}` });
    events.push(
      { type: "tool_start", tool: "get_forecast", args: {} },
      {
        type: "tool_end",
        tool: "get_forecast",
        ms: 24,
        summary: "已读取预测记录",
      },
      { type: "answer_delta", text: answer },
      { type: "done", known: true, grounded: true, needs_human: false },
    );
    return route.fulfill({
      contentType: "text/event-stream",
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "Agent 决策" }).click();
  const card = page.locator(".agent-chat-card");
  const before = await card.boundingBox();
  await page.getByRole("textbox", { name: "运维问题" }).fill("请查询预测");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-user > small")).toHaveText("值班工程师");
  await expect(page.locator(".agent-answer-text")).toHaveText(answer);
  await page.locator(".agent-chat-process summary").click();
  for (const size of await card
    .locator(
      ".agent-process-list li,.agent-process-list code,.agent-process-list small,.agent-answer-text",
    )
    .evaluateAll((es) =>
      es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
    ))
    expect(size).toBeGreaterThanOrEqual(11);
  expect(
    await page
      .locator(".agent-process-list")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(true);
  expect(
    await page
      .locator(".agent-chat-messages")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(true);
  const after = await card.boundingBox();
  expect(after!.height).toBeGreaterThan(before!.height);
  expect(after!.height).toBeLessThan(700);
});
