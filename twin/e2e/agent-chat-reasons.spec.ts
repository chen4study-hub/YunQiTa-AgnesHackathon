import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test("done reasons, online template badge, Chinese web tool and clickable sources", async ({
  page,
  context,
}) => {
  const replies = [
    { reason: "no_data", answer: "暂无这栋楼的记录。" },
    { reason: undefined, answer: "不知道。" },
    { reason: "out_of_scope", answer: "不知道。" },
    {
      reason: "answered",
      answer:
        "来源：[官方来源](https://example.com/2017-01-01?q=演示)；另见 https://example.org/report。",
    },
  ];
  let calls = 0;
  await page.route("**/api/**", async (r) => {
    // Both LLM badges now follow /health, not the local schedule/source mode.
    // This online contract fixture must supply health rather than aborting it.
    if (new URL(r.request().url()).pathname === "/api/health")
      return r.fulfill({ json: { llm: { mode: "real" } } });
    if (!r.request().url().endsWith("/chat/stream")) return r.abort();
    const reply = replies[calls++];
    const events = [
      { type: "tool_start", tool: "web_search", args: {} },
      { type: "tool_end", tool: "web_search", ms: 12, summary: "来源已找到" },
      { type: "answer_delta", text: reply.answer },
      {
        type: "done",
        known: reply.reason === "answered",
        grounded: true,
        needs_human: false,
        reason: reply.reason,
      },
    ];
    await r.fulfill({
      contentType: "text/event-stream",
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await expect(page.locator(".agent-chat-header-actions")).toContainText(
    "LLM 在线",
  );
  await expect(page.locator(".agent-root")).not.toContainText("LLM 预置应答");
  for (let i = 0; i < replies.length; i++) {
    await page.getByRole("textbox", { name: "运维问题" }).fill(`问题 ${i}`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const answer = page.locator(".agent-answer-text").last();
    await expect(answer).toContainText(
      i === 1 || i === 2 ? "不知道。" : i === 3 ? "来源：" : replies[i].answer,
    );
  }
  const process = page.locator(".agent-chat-process").last();
  await expect(process).toHaveAttribute("open", "");
  await expect(process.locator(".agent-process-tool")).toContainText(
    "联网查询",
  );
  await expect(page.locator(".agent-tool-tags").last()).toHaveText("联网查询");
  await expect(page.locator(".agent-chat-messages")).not.toContainText(
    "web_search",
  );
  const link = page
    .locator(".agent-answer-text")
    .last()
    .getByRole("link", { name: "官方来源", exact: true });
  await expect(link).toHaveAttribute(
    "href",
    "https://example.com/2017-01-01?q=演示",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await context.route("https://example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>来源</title>" }),
  );
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toContain("example.com/2017-01-01");
  await popup.close();
  expect(calls).toBe(4);
});
