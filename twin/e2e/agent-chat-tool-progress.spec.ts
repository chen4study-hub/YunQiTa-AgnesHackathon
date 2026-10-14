import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const width of [1366, 390])
  test.describe(`tool progress ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 768 } });
    test("tool_end and done remove in-progress narration, retaining completed tool evidence", async ({
      page,
    }, info) => {
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/chat/stream"))
          return route.abort();
        const events = [
          { type: "step", text: "正在联网查询…" },
          { type: "tool_start", tool: "web_search", args: {} },
          {
            type: "tool_end",
            tool: "web_search",
            ms: 35.6,
            summary: "没有查到网上资料",
          },
          { type: "step", text: "正在查询相关数据…" },
          { type: "tool_start", tool: "current_energy", args: {} },
          {
            type: "tool_end",
            tool: "current_energy",
            summary: "已查询当前能源",
          },
          { type: "answer_delta", text: "后端回答已经完成。" },
          { type: "done", known: true, grounded: true, needs_human: false },
        ];
        await route.fulfill({
          contentType: "text/event-stream",
          body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        });
      });
      await page.addInitScript(() => {
        const original = window.fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (!String(args[0]).endsWith("/chat/stream")) return response;
          const chunks = (await response.text()).split("\n\n").filter(Boolean);
          return new Response(
            new ReadableStream({
              async start(c) {
                for (const chunk of chunks) {
                  c.enqueue(new TextEncoder().encode(chunk + "\n\n"));
                  await new Promise((r) => setTimeout(r, 600));
                }
                c.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        };
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page.getByRole("textbox", { name: "运维问题" }).fill("请联网查询");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const process = page.locator(".agent-chat-process");
      await expect(process).toContainText("正在联网查询");
      await expect(page.locator('[data-tool="web_search"]')).toHaveAttribute(
        "data-tool-state",
        "done",
      );
      await expect(process).not.toContainText("正在联网查询");
      await expect(process).toContainText("正在查询相关数据");
      await expect(
        page.locator('[data-tool="current_energy"]'),
      ).toHaveAttribute("data-tool-state", "done");
      await expect(process).not.toContainText("正在查询相关数据");
      await expect(
        page.getByRole("textbox", { name: "运维问题" }),
      ).toBeEnabled();
      await expect(page.locator(".agent-answer-text")).toHaveText(
        "后端回答已经完成。",
      );
      await expect(process).not.toContainText("正在");
      await expect(process.locator("[data-step-running]")).toHaveCount(0);
      await expect(process).toContainText("没有查到网上资料");
      await expect(process).toContainText("35.6 ms");
      const frontendDuration = await page
        .locator('[data-tool="current_energy"] .agent-step-time')
        .innerText();
      const measured = Number(frontendDuration.match(/([\d.]+) (ms|s)/)?.[1]);
      const unit = frontendDuration.match(/([\d.]+) (ms|s)/)?.[2];
      expect(measured * (unit === "s" ? 1000 : 1)).toBeGreaterThan(400);
      expect(measured * (unit === "s" ? 1000 : 1)).toBeLessThan(2000);
      await expect(process).not.toContainText("0.0 s");
      await expect(process.locator("summary")).toHaveText(
        /已调用 2 个工具 · \d+\.\d s · 收起/,
      );
      await expect(process.locator('[aria-label="已完成"]')).toHaveCount(2);
      // Reopening details cannot revive a completed progress hint.
      await process.locator("summary").click();
      await process.locator("summary").click();
      await expect(process).not.toContainText("正在");
      await process.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("completed-tools.png") });
    });
  });
