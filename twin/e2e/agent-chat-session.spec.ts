import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test("active answer survives page unmount, final survives reload; new conversation aborts and clears", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/**", async (r) => {
    if (!r.request().url().endsWith("/chat/stream")) return r.abort();
    calls++;
    await r.fulfill({
      contentType: "text/event-stream",
      body: [
        { type: "answer_delta", text: "第一句。" },
        { type: "answer_delta", text: "第二句。" },
        { type: "answer_delta", text: "最后一句。" },
        { type: "done", known: true, grounded: true, needs_human: false },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
    });
  });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!String(args[0]).endsWith("/chat/stream")) return response;
      const signal = (args[1] as RequestInit)?.signal;
      const chunks = (await response.text()).split("\n\n").filter(Boolean);
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const chunk of chunks) {
              await new Promise((r) => setTimeout(r, 1200));
              if (signal?.aborted) {
                c.error(new DOMException("Aborted", "AbortError"));
                return;
              }
              c.enqueue(new TextEncoder().encode(chunk + "\n\n"));
            }
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await page.getByRole("textbox", { name: "运维问题" }).fill("保留这段对话");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-answer-text").last()).toHaveText(
    "第一句。",
  );
  await page.getByRole("button", { name: /预测与风险/ }).click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(page.locator(".agent-answer-text").last()).toContainText(
    "第二句。",
  );
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
  await expect(page.locator(".agent-answer-text").last()).toHaveText(
    "第一句。第二句。最后一句。",
  );
  expect(calls).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(page.locator(".agent-answer-text").last()).toHaveText(
    "第一句。第二句。最后一句。",
  );
  expect(calls).toBe(1);
  await page
    .getByRole("textbox", { name: "运维问题" })
    .fill("新会话会取消这次回答");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeDisabled();
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await expect(page.locator(".agent-user")).toHaveCount(0);
  await expect(page.locator(".agent-answer-text")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
  await page.waitForTimeout(5000);
  await expect(page.locator(".agent-answer-text")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(page.locator(".agent-user")).toHaveCount(0);
  await expect(page.locator(".agent-chat-welcome")).toBeVisible();
});
