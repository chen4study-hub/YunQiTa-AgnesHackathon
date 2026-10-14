import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";
import { assertDisplayText } from "./agent-forecast-visible";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`conclusions only ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("two pages retain conclusions without method panels, clipping or false scrolling", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => {
        if (!r.request().url().endsWith("/chat/stream")) return r.abort();
        return r.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "tool_start", tool: "get_forecast", args: {} },
            {
              type: "tool_end",
              tool: "get_forecast",
              ms: 0.936,
              summary: "沿用预测，推算峰值 1,234.5 kW；非实测，演示数据。",
            },
            { type: "answer_delta", text: "预计峰值 1,234.5 kW。" },
            { type: "done", known: true, grounded: true, needs_human: false },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
        });
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T10:00");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await expect(page.locator(".forecast-root")).toHaveAttribute(
        "data-source",
        "contract-1.2",
      );
      await expect(
        page.locator(".forecast-model .forecast-heading"),
      ).toContainText("模型指标");
      await expect(
        page.locator(".forecast-floors .forecast-heading"),
      ).toContainText("当前小时 · kW");
      await expect(page.locator(".forecast-model-details")).toHaveCount(0);
      await expect(page.locator(".forecast-root")).not.toContainText(
        /非校准概率|model_card\.json|评估口径|分配规则计算/,
      );
      for (const summary of await page
        .locator(".forecast-details summary")
        .all())
        await summary.click();
      await assertDisplayText(page);
      // Restore closed state before testing card fill and screenshot.
      for (const summary of await page
        .locator(".forecast-details summary")
        .all())
        await summary.click();
      const geometry = await page.locator(".forecast-model").evaluate((el) => {
        const card = el.getBoundingClientRect(),
          region = el
            .querySelector(".forecast-model-scroll")!
            .getBoundingClientRect(),
          table = el.querySelector("table")!.getBoundingClientRect();
        return {
          card: card.toJSON(),
          table: table.toJSON(),
          region: region.toJSON(),
          bottomGap: card.bottom - table.bottom,
          regionGap: region.bottom - table.bottom,
          overflow: el.scrollHeight - el.clientHeight,
        };
      });
      // Tables need not stretch to fill a content-sized model card. Readability owns the page.
      await assertShellScrolling(page, "conclusions readability");
      if (size.width >= 1180) {
        expect(geometry.table.bottom).toBeLessThanOrEqual(geometry.card.bottom);
        expect(geometry.table.left).toBeGreaterThanOrEqual(geometry.card.left);
        expect(geometry.table.right).toBeLessThanOrEqual(geometry.card.right);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
      }
      await info.attach("forecast-conclusions", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(6);
      await page.getByRole("button", { name: "展开调度理由" }).click();
      await assertDisplayText(page);
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("region", { name: "候选方案表" }),
      ).toContainText("预计电费");
      await assertDisplayText(page);
      await page.getByRole("textbox", { name: "运维问题" }).fill("未来峰值？");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.locator(".agent-answer-text").last()).toContainText(
        "预计峰值",
      );
      await expect(page.locator(".agent-chat-process").last()).toHaveAttribute(
        "open",
        "",
      );
      await assertDisplayText(page);
      await expect(page.locator(".agent-chat-process").last()).toContainText(
        "1,234.5",
      );
      expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
    });
  });
  });
