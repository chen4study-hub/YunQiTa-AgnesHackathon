import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
import { assertDisplayText } from "./agent-forecast-visible";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const width of [1366, 390])
  test.describe(`LLM badge ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 768 } });
    test("both badges follow health and agree with the first-message banner", async ({
      page,
    }, info) => {
      let mode = "mock";
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/health")
          return route.fulfill({ json: { llm: { mode } } });
        if (path === "/api/chat/stream")
          return route.fulfill({
            contentType: "text/event-stream",
            body:
              "data: " +
              JSON.stringify({ type: "answer_delta", text: "后端回答原文。" }) +
              "\n\ndata: " +
              JSON.stringify({
                type: "done",
                mode: "fallback",
                grounded: true,
              }) +
              "\n\n",
          });
        return route.abort();
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      const badges = page.locator(".agent-llm-badge");
      await expect(badges).toHaveCount(2);
      await expect(badges).toHaveText(["未接 LLM", "未接 LLM"]);
      await expect(page.getByText("LLM 在线", { exact: true })).toHaveCount(0);
      const source = await page.locator(".agent-decision-source").textContent();
      for (const badge of await badges.all()) {
        await expect(badge).toHaveClass(/agent-llm-inactive/);
        const style = await badge.evaluate((e) => {
          const s = getComputedStyle(e);
          return {
            fg: s.color,
            bg: s.backgroundColor,
            font: parseFloat(s.fontSize),
          };
        });
        expect(style.bg).toBe("rgb(37, 40, 44)");
        expect(style.fg).toBe("rgb(194, 198, 203)");
        expect(style.font).toBeGreaterThanOrEqual(14);
      }
      await page.locator(".agent-decision-card").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("decision-badge.png") });
      const ask = async () => {
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill("今天负荷如何？");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(
          page.getByRole("textbox", { name: "运维问题" }),
        ).toBeEnabled();
      };
      await ask();
      await expect(page.locator(".agent-llm-notice")).toBeVisible();
      await expect(badges).toHaveText(["未接 LLM", "未接 LLM"]);
      await assertDisplayText(page);
      await page.locator(".agent-chat-card").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("chat-badge.png") });
      mode = "real";
      await ask();
      await expect(badges).toHaveText(["LLM 在线", "LLM 在线"]);
      await expect(page.locator(".agent-llm-notice")).toHaveCount(0);
      await expect(page.locator(".agent-llm-inactive")).toHaveCount(0);
      await expect(page.locator(".agent-decision-source")).toHaveText(source!);
    });
  });
