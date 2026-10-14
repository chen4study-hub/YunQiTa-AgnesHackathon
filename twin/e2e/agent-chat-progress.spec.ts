import { test, expect } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const terminal of ["answer_delta", "done", "error"])
  test(`progress reuses one DOM row and clears on ${terminal}`, async ({
    page,
  }) => {
    await page.route("**/api/chat/stream", async (r) => {
      const events = [
        { type: "tool_start", tool: "current_energy", args: {} },
        {
          type: "tool_end",
          tool: "current_energy",
          ms: 2.1,
          summary: "光伏 20.1 kW",
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          type: "progress",
          id: "chat-answer-wait",
          text: `正在组织回答，已等待 ${i + 1} 秒`,
          elapsed_seconds: i + 1,
        })),
        terminal === "answer_delta"
          ? { type: terminal, text: "光伏 20.1 kW。" }
          : terminal === "done"
            ? {
                type: terminal,
                known: true,
                grounded: true,
                needs_human: false,
              }
            : { type: terminal, message: "连接结束" },
        ...(terminal === "done"
          ? []
          : [
              { type: "done", known: true, grounded: true, needs_human: false },
            ]),
      ];
      // Browser fixture re-chunks these bytes with spacing to observe each React update.
      await r.fulfill({
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        contentType: "text/event-stream",
      });
    });
    await page.route("**/api/health", (r) => r.abort());
    await page.route("**/api/schedule", (r) => r.abort());
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
                await new Promise((r) => setTimeout(r, 80));
              }
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      };
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await expect(page.getByText("数据加载中…", { exact: true })).toHaveCount(
      0,
      { timeout: 15000 },
    );
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-chat-messages")).toBeVisible();
    await page.evaluate(() => {
      (window as any).maxWaiting = 0;
      (window as any).duplicateWait = false;
      new MutationObserver(() => {
        const n = document.querySelectorAll(
          '[data-progress-id="chat-answer-wait"]',
        ).length;
        (window as any).maxWaiting = Math.max((window as any).maxWaiting, n);
        (window as any).duplicateWait ||= document
          .querySelector(".agent-chat-messages")!
          .textContent!.includes("正在接收工具过程与回答");
      }).observe(document.querySelector(".agent-chat-messages")!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page
      .getByRole("textbox", { name: "运维问题" })
      .fill("现在光伏发电多少");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
    await expect(
      page.locator('[data-progress-id="chat-answer-wait"]'),
    ).toHaveCount(0);
    if (
      !(
        (await page.locator(".agent-chat-process").getAttribute("open")) !==
        null
      )
    )
      await page.locator(".agent-chat-process summary").click();
    await expect(page.locator(".agent-process-list")).toContainText(
      "查询当前能源",
    );
    expect(await page.evaluate(() => (window as any).maxWaiting)).toBe(1);
    expect(await page.evaluate(() => (window as any).duplicateWait)).toBe(
      false,
    );
    await expect(page.locator(".agent-chat-progress")).toHaveCount(0);
  });
