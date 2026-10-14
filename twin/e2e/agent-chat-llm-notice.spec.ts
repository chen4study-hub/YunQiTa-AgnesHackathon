import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
import {
  assertDisplayText,
  forbiddenDisplayText,
} from "./agent-forecast-visible";
import { LLM_LIMIT_NOTICE } from "../src/pages/agent/ChatLlmNotice";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  { width: 1280, height: 664, dpr: 1.25 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`LLM banner ${size.width}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.dpr,
    });
    test("first send, persistence, reset, real LLM and input geometry", async ({
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
      const notice = page.locator(".agent-llm-notice");
      const input = page.getByRole("textbox", { name: "运维问题" });
      const ask = async () => {
        await input.fill("今天负荷如何？");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(
          page.locator(".agent-assistant").last().locator(".agent-answer-text"),
        ).toHaveText("后端回答原文。");
        await expect(input).toBeEnabled();
      };
      await expect(notice).toHaveCount(0);
      await input.scrollIntoViewIfNeeded();
      const before = await input.boundingBox();
      await ask();
      await expect(notice).toHaveText(LLM_LIMIT_NOTICE);
      await expect(notice.locator("button")).toHaveCount(0);
      await assertDisplayText(page);
      // Exception applies to exactly this banner, never other text or altered copy.
      await notice.evaluate((e) => (e.textContent += " 模拟"));
      expect(await forbiddenDisplayText(page)).not.toEqual([]);
      await notice.evaluate(
        (e, text) => (e.textContent = text),
        LLM_LIMIT_NOTICE,
      );
      const style = await notice.evaluate((e) => {
        const s = getComputedStyle(e);
        return {
          font: parseFloat(s.fontSize),
          fg: s.color,
          bg: s.backgroundColor,
        };
      });
      expect(style.font).toBe(15);
      const luminance = (rgb: string) => {
        const c = rgb
          .match(/\d+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
        return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
      };
      expect(
        (luminance(style.fg) + 0.05) / (luminance(style.bg) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      const after = await input.boundingBox();
      expect(after!.height).toBeGreaterThanOrEqual(36);
      if (size.width >= 1180)
        expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
      await notice.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("llm-banner.png") });
      await expect(input).toBeVisible();
      await input.evaluate((e) => e.scrollIntoView({ block: "center" }));
      const inputBox = await input.boundingBox();
      const footerBox = await page.locator(".bottombar").boundingBox();
      expect(inputBox!.y).toBeGreaterThanOrEqual(0);
      expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(footerBox!.y);
      await page.screenshot({ path: info.outputPath("input-preserved.png") });
      await ask();
      await expect(notice).toHaveText(LLM_LIMIT_NOTICE);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(notice).toHaveText(LLM_LIMIT_NOTICE);
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await expect(notice).toHaveCount(0);
      await ask();
      await expect(notice).toHaveText(LLM_LIMIT_NOTICE);
      mode = "real";
      await ask(); // Refresh health through the existing send lifecycle.
      await expect(notice).toHaveCount(0);
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await expect(notice).toHaveCount(0);
      await ask();
      await expect(notice).toHaveCount(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(notice).toHaveCount(0);
    });
  });
