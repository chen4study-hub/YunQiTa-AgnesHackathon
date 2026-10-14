import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
])
  test.describe(`fixed desktop chat ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("six long questions keep the card pinned, only messages and left column scroll", async ({
      page,
    }, info) => {
      let calls = 0;
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/chat/stream"))
          return route.abort();
        const n = ++calls;
        return route.fulfill({
          contentType: "text/event-stream",
          body: [
            {
              type: "answer_delta",
              text:
                `回答 ${n}：` +
                "请核对当前小时的工具记录与设备状态。".repeat(80),
            },
            { type: "done", known: true, grounded: true, needs_human: false },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
        });
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const measure = () =>
        page.evaluate(() => {
          const el = (s: string) => document.querySelector(s) as HTMLElement;
          const root = el(".agent-root"),
            card = el(".agent-chat-card"),
            left = el(".agent-left-slot"),
            msg = el(".agent-chat-messages");
          return {
            viewport: innerHeight,
            documentHeight: document.scrollingElement!.scrollHeight,
            rootHeight: root.clientHeight,
            rootScroll: root.scrollHeight,
            card: card.getBoundingClientRect().toJSON(),
            ch: card.clientHeight,
            csh: card.scrollHeight,
            footer: el(".bottombar").getBoundingClientRect().top,
            main: el("main").getBoundingClientRect().toJSON(),
            form: el(".agent-chat-form").getBoundingClientRect().toJSON(),
            quick: el(".agent-quick-questions")
              .getBoundingClientRect()
              .toJSON(),
            mh: msg.clientHeight,
            msh: msg.scrollHeight,
            lsh: left.scrollHeight,
            lh: left.clientHeight,
            leftOverflow: getComputedStyle(left).overflowY,
          };
        });
      const before = await measure();
      for (let n = 1; n <= 6; n++) {
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill(`问题 ${n}：` + "请核对调度依据和设备运行记录。".repeat(70));
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(page.locator(".agent-answer-text").last()).toContainText(
          `回答 ${n}：`,
        );
        const m = await measure();
        expect(m.documentHeight).toBe(m.viewport);
        expect(m.rootScroll).toBe(m.rootHeight);
        expect(m.card.bottom).toBeLessThanOrEqual(m.footer);
        expect(
          Math.abs(m.card.height - before.card.height),
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(m.card.bottom - m.main.bottom)).toBeLessThanOrEqual(1);
        expect(m.csh).toBe(m.ch);
        expect(m.msh).toBeGreaterThan(m.mh);
        expect(m.form.bottom).toBeLessThan(m.card.bottom);
        expect(m.quick.bottom).toBeLessThanOrEqual(m.form.top);
        expect(Math.abs(m.form.y - before.form.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.quick.y - before.quick.y)).toBeLessThanOrEqual(1);
        expect(m.leftOverflow).toBe("auto");
      }
      // Force long content on the left to prove it cannot grow the outer grid/right card.
      await page.evaluate(() =>
        document
          .querySelector(".agent-left-slot")!
          .insertAdjacentHTML(
            "beforeend",
            '<p style="min-height:2000px">左列独立滚动验证</p>',
          ),
      );
      const end = await measure();
      expect(end.lsh).toBeGreaterThan(end.lh);
      expect(end.rootScroll).toBe(end.rootHeight);
      expect(end.card.height).toBe(before.card.height);
      expect(end.documentHeight).toBe(end.viewport);
      await info.attach("fixed-chat", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
  });
