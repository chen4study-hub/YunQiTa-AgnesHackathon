import { test, expect } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
import { freezeTestHmr } from "./shell-scroll-policy";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import { currentUI4183 } from "./agent-local-ui-4183";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
for (const category of ["politics", "current_affairs"])
  for (const transport of ["sse", "json"])
    test(`${category} ${transport}: terminate, disable, persist and new session rotates ID`, async ({
      page,
    }, info) => {
      await currentUI4183(page);
      const requests: any[] = [];
      let terminate = true;
      const refusal = "这是后端拒绝原文，不由前端改写。";
      await page.route("**/api/chat/stream", (r) => {
        requests.push(r.request().postDataJSON());
        if (transport === "json") return r.fulfill({ status: 404, body: "" });
        return r.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "answer_delta", text: terminate ? refusal : "新会话回答" },
            {
              type: "done",
              terminated: terminate,
              category: terminate ? category : "none",
              mode: "llm",
              known: !terminate,
              grounded: true,
              needs_human: false,
            },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join("")
            .replaceAll("\\n", "\n"),
        });
      });
      await page.route("**/api/chat", (r) => {
        requests.push(r.request().postDataJSON());
        return r.fulfill({
          json: {
            answer: terminate ? refusal : "新会话回答",
            terminated: terminate,
            category: terminate ? category : "none",
            mode: "fallback",
          },
        });
      });
      await page.goto("/?scenario=normal&at=2026-10-13T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page
        .getByRole("button", { name: "未来24小时峰值是多少？", exact: true })
        .click();
      const last = page.locator(".agent-assistant").last();
      await expect(last.locator(".agent-answer-text")).toHaveText(refusal);
      await expect(last.locator(".agent-answer-category")).toHaveText(
        category === "politics" ? "涉政" : "时事",
      );
      await expect(page.locator(".agent-chat-ended")).toHaveText(
        "本会话已结束，请开启新会话",
      );
      const input = page.getByRole("textbox", { name: "运维问题" });
      await expect(input).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "发送", exact: true }),
      ).toBeDisabled();
      for (const button of await page
        .locator(".agent-quick-questions button")
        .all())
        await expect(button).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "新会话", exact: true }),
      ).toBeEnabled();
      const id = requests[0].session_id;
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect(requests.every((r) => r.session_id === id)).toBe(true);
      const count = requests.length;
      await page.screenshot({ path: info.outputPath("terminated.png") });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(input).toBeDisabled();
      await expect(
        page
          .locator(".agent-assistant")
          .last()
          .locator(".agent-answer-category"),
      ).toHaveText(category === "politics" ? "涉政" : "时事");
      expect(requests.length).toBe(count);
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await expect(input).toBeEnabled();
      await expect(page.locator(".agent-chat-ended")).toHaveCount(0);
      await expect(page.locator(".agent-answer-category")).toHaveCount(0);
      terminate = false;
      await page
        .getByRole("button", { name: "未来24小时峰值是多少？", exact: true })
        .click();
      await expect(
        page.locator(".agent-assistant").last().locator(".agent-answer-text"),
      ).toHaveText("新会话回答");
      expect(requests.at(-1).session_id).not.toBe(id);
      await expect(input).toBeEnabled();
      await info.attach("session-requests", {
        body: JSON.stringify(requests),
        contentType: "application/json",
      });
    });
