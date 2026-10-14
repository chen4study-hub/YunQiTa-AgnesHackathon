import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`time/weather labels ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("SSE tools show Chinese labels while running and after completion", async ({
      page,
    }, info) => {
      await page.route("**/api/**", async (r) => {
        if (!r.request().url().endsWith("/chat/stream")) return r.abort();
        const events = [
          { type: "tool_start", tool: "get_time", args: {} },
          {
            type: "tool_end",
            tool: "get_time",
            ms: 0.936,
            summary: "时间已查询",
          },
          { type: "tool_start", tool: "get_weather", args: {} },
          {
            type: "tool_end",
            tool: "get_weather",
            ms: 3.71,
            summary: "天气已查询",
          },
          { type: "tool_start", tool: "get_forecast", args: {} },
          {
            type: "tool_end",
            tool: "get_forecast",
            ms: 12.6,
            summary: "预测已查询",
          },
          { type: "answer_delta", text: "当前时间和天气已查询。" },
          { type: "done", known: true, grounded: true, needs_human: false },
        ];
        return r.fulfill({
          contentType: "text/event-stream",
          body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        });
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await page
        .getByRole("textbox", { name: "运维问题" })
        .fill("现在几点，天气怎么样？");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const process = page.locator(".agent-chat-process").last();
      await expect(process.locator("summary")).toContainText("已调用 3 个工具");
      await expect(process).toHaveAttribute("open", "");
      const time = process.locator('[data-tool="get_time"]'),
        weather = process.locator('[data-tool="get_weather"]');
      await expect(time).toContainText("查询时间");
      await expect(weather).toContainText("查询天气");
      await expect(time).toHaveAttribute("data-tool", "get_time");
      await expect(weather).toHaveAttribute("data-tool", "get_weather");
      for (const row of [time, weather]) {
        await expect(row).toHaveAttribute("data-tool-state", "done");
        await expect(row.getByLabel("已完成")).toBeVisible();
      }
      // 070981e preserves subsecond timings in milliseconds.
      await expect(time).toContainText("0.9 ms");
      await expect(weather).toContainText("3.7 ms");
      await expect(process.locator(".agent-step-label")).toHaveText([
        "查询时间",
        "查询天气",
        "负荷预测查询",
      ]);
      const message = await page.locator(".agent-chat-card").innerText();
      expect(message).not.toMatch(/\d\.\d{3,}/);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
      if (size.width >= 1366)
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBe(size.height);
      await info.attach("time-weather-ui", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
  });
