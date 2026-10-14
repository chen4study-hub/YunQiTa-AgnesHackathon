import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
const cases = [
  {
    name: "Retry-After",
    body: { message: "提问太频繁", retry_after_seconds: 99 },
    header: "3",
    wait: 3,
    width: 1366,
  },
  {
    name: "JSON seconds",
    body: {
      detail: { message: "提问过于频繁，请等待 5 秒后再试。", wait_seconds: 5 },
    },
    header: undefined,
    wait: 5,
    width: 390,
  },
  {
    name: "default 60",
    body: { message: "提问太频繁" },
    header: undefined,
    wait: 60,
    width: 1366,
  },
];
for (const c of cases) {
  test.describe(c.name, () => {
    test.use({
      viewport: { width: c.width, height: c.width === 390 ? 844 : 768 },
    });
    test("429 is an independent countdown, retains input and permits manual resend only after expiry", async ({
      page,
    }, info) => {
      const calls: string[] = [];
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/chat/stream") {
          calls.push(path);
          if (calls.length === 1)
            return route.fulfill({
              status: 429,
              contentType: "application/json",
              headers: c.header ? { "Retry-After": c.header } : {},
              body: JSON.stringify(c.body),
            });
          return route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"answer_delta","text":"核对完成。"}\n\ndata: {"type":"done","known":true,"grounded":true,"needs_human":false}\n\n',
          });
        }
        if (path === "/api/chat") {
          calls.push(path);
          return route.abort();
        }
        return route.abort();
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-14T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      const time = new Date("2026-10-14T14:00:00Z");
      await page.clock.install({ time });
      await page.clock.pauseAt(new Date(time.getTime() + 1000));
      const input = page.getByRole("textbox", { name: "运维问题" }),
        send = page.getByRole("button", { name: "发送", exact: true });
      const question = " 核对电价和能耗 ";
      await input.fill(question);
      await send.click();
      const notice = page.locator(".agent-chat-rate-limit");
      await expect(notice).toHaveText(`提问太频繁了，请 ${c.wait} 秒后再试`);
      await expect(send).toBeDisabled();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue(question);
      await expect(
        page.locator(".agent-quick-questions button").first(),
      ).toBeDisabled();
      await expect(
        page.locator(
          ".agent-chat-request-error, .agent-answer-review, .agent-chat-ended, .agent-chat-process, .agent-answer-text",
        ),
      ).toHaveCount(0);
      expect(calls).toEqual(["/api/chat/stream"]);
      // Enter must also respect the cooldown, even though editing remains available.
      await input.press("Enter");
      expect(calls).toHaveLength(1);
      await page.clock.runFor(1000);
      await expect(notice).toHaveText(
        `提问太频繁了，请 ${c.wait - 1} 秒后再试`,
      );
      await expect(send).toBeDisabled();
      // Remounting the page must neither restart nor discard the cooldown/draft.
      await page.getByRole("button", { name: /预测与风险/ }).click();
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(input).toHaveValue(question);
      await expect(send).toBeDisabled();
      await page.screenshot({ path: info.outputPath("chat-rate-limit.png") });
      await page.clock.runFor((c.wait - 2) * 1000);
      await expect(notice).toHaveText("提问太频繁了，请 1 秒后再试");
      await expect(send).toBeDisabled();
      expect(calls).toHaveLength(1);
      await page.clock.runFor(1000);
      await expect(notice).toHaveText("等待已结束，可以再次提问。");
      await expect(send).toBeEnabled();
      await expect(
        page.locator(".agent-quick-questions button").first(),
      ).toBeEnabled();
      await expect(input).toHaveValue(question);
      expect(calls).toHaveLength(1);
      await send.click();
      await expect(page.locator(".agent-answer-text")).toHaveText("核对完成。");
      await expect(input).toHaveValue("");
      expect(calls).toEqual(["/api/chat/stream", "/api/chat/stream"]);
    });
  });
}
