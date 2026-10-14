import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test("streamed Markdown has no stray markers; basic blocks, links and hostile HTML stay safe", async ({
  page,
}) => {
  await page.route("**/api/**", async (r) => {
    if (!r.request().url().endsWith("/chat/stream")) return r.abort();
    const events = [
      { type: "answer_delta", text: "**正在组织" },
      {
        type: "answer_delta",
        text: "回答**和*斜体* 🙂\n下一行\n\n1. 第一项\n2. 第二项\n\n- 项目\n- `代码`\n\n<img src=x onerror=alert(1)>\n您可以访问[官网](https://example.com/report)或上述API链接查看。另见 https://example.org/data 和（https://example.net/api）。",
      },
      { type: "done", known: true, grounded: true, needs_human: false },
    ];
    await r.fulfill({
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
              await new Promise((r) => setTimeout(r, 1200));
            }
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await expect(page.getByText("数据加载中…", { exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await page.getByRole("textbox", { name: "运维问题" }).fill("讲讲常识");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const answer = page.locator(".agent-answer-text");
  await expect(answer.locator("strong")).toContainText("正在组织");
  await expect(answer).not.toContainText("**");
  await expect(answer.locator("strong")).toHaveText("正在组织回答");
  await expect(answer.locator("em")).toHaveText("斜体");
  await expect(answer.locator("ol li")).toHaveCount(2);
  await expect(answer.locator("ul li")).toHaveCount(2);
  await expect(answer.locator("code")).toHaveText("代码");
  await expect(answer.locator("br")).toHaveCount(2);
  await expect(answer).toContainText("<img src=x onerror=alert(1)>");
  await expect(answer.locator("img,script")).toHaveCount(0);
  await expect(page.locator(".agent-answer-sources a").first()).toHaveAttribute(
    "rel",
    "noreferrer",
  );
  await expect(page.locator(".agent-answer-sources a").first()).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(answer.locator("a")).toHaveCount(3);
  await expect(answer.locator("a").nth(0)).toHaveAttribute(
    "href",
    "https://example.com/report",
  );
  await expect(answer.locator("a").nth(1)).toHaveAttribute(
    "href",
    "https://example.org/data",
  );
  await expect(answer.locator("a").nth(2)).toHaveAttribute(
    "href",
    "https://example.net/api",
  );
  await expect(answer).toContainText("您可以访问官网或上述API链接查看");
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
});
