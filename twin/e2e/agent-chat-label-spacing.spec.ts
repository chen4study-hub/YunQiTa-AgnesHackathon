import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });

for (const size of [
  { width: 390, height: 844, dpr: 1 },
  { width: 1280, height: 664, dpr: 1.25 },
])
  test.describe(`chat label spacing ${size.width}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.dpr,
    });
    test("answer labels have 6px spacing without changing their text", async ({
      page,
    }, info) => {
      // Saved backend messages exercise the same bubble rendering without API writes.
      await page.addInitScript(() =>
        sessionStorage.setItem(
          "yunqi-agent-chat-v1",
          JSON.stringify({
            version: 1,
            sessionId: "label-spacing-session",
            terminated: true,
            messages: [
              {
                id: 1,
                role: "assistant",
                source: "backend",
                text: "后端涉政拒绝原文。",
                tools: [],
                terminated: true,
                category: "politics",
              },
              {
                id: 2,
                role: "assistant",
                source: "backend",
                text: "后端时事拒绝原文。",
                tools: [],
                terminated: true,
                category: "current_affairs",
              },
              {
                id: 3,
                role: "assistant",
                source: "backend",
                text: "后端回答需值班人员复核。",
                tools: [],
                needsHuman: true,
              },
            ],
          }),
        ),
      );
      await page.route("**/api/**", (route) => route.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
      const labels = page.locator(
        ".agent-answer-category, .agent-answer-review",
      );
      await expect(labels).toHaveText(["涉政", "时事", "需值班人员复核"]);
      for (let i = 0; i < 3; i++) {
        const label = labels.nth(i);
        await label.scrollIntoViewIfNeeded();
        const geometry = await label.evaluate((e) => {
          const title = e
            .closest(".agent-bubble")!
            .querySelector(":scope > small")!;
          const range = document.createRange();
          range.selectNodeContents(title);
          const a = range.getBoundingClientRect(),
            b = e.getBoundingClientRect();
          return {
            margin: getComputedStyle(e).marginInlineStart,
            title: title.textContent,
            horizontalGap: b.left - a.right,
            sameLine: Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
          };
        });
        expect(geometry.margin).toBe("6px");
        expect(geometry.title).toBe("Agent · 服务端回答");
        // Category badges directly follow the heading; review stays below the answer.
        if (i < 2) {
          expect(geometry.sameLine).toBe(true);
          expect(geometry.horizontalGap).toBeCloseTo(6, 1);
        }
        await page.screenshot({ path: info.outputPath(`label-${i}.png`) });
      }
    });
  });
