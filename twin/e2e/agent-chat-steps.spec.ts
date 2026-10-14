import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const motion of ["no-preference", "reduce"] as const)
  for (const width of [1366, 390])
    test.describe(`steps ${motion} ${width}`, () => {
      test.use({
        reducedMotion: motion,
        viewport: { width, height: width === 390 ? 844 : 768 },
      });
      test("soft aligned steps, in-place completion, sources underneath and no frontend question gate", async ({
        page,
      }) => {
        test.setTimeout(60000);
        await page.emulateMedia({ reducedMotion: motion });
        expect(
          await page.evaluate(
            () => matchMedia("(prefers-reduced-motion: reduce)").matches,
          ),
        ).toBe(motion === "reduce");
        let question = "";
        await page.route("**/api/**", async (r) => {
          if (!r.request().url().endsWith("/chat/stream")) return r.abort();
          question = r.request().postDataJSON().question;
          const events = [
            { type: "tool_start", tool: "web_search", args: {} },
            {
              type: "tool_end",
              tool: "web_search",
              ms: 1600,
              summary: "找到官网来源",
            },
            { type: "tool_start", tool: "current_energy", args: {} },
            {
              type: "tool_end",
              tool: "current_energy",
              ms: 900,
              summary: "已查询",
            },
            {
              type: "progress",
              id: "chat-answer-wait",
              text: "正在组织回答，已等待 2 秒",
              elapsed_seconds: 2,
            },
            {
              type: "answer_delta",
              text: "这是一条联网回答。[官网](https://example.com/report)",
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
            const chunks = (await response.text())
              .split("\n\n")
              .filter(Boolean);
            return new Response(
              new ReadableStream({
                async start(c) {
                  for (const [i, chunk] of chunks.entries()) {
                    c.enqueue(new TextEncoder().encode(chunk + "\n\n"));
                    await new Promise((r) =>
                      setTimeout(r, i === 0 || i === 4 ? 4000 : 1200),
                    );
                  }
                  c.close();
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          };
        });
        await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
        await expect(
          page.getByText("数据加载中…", { exact: true }),
        ).toHaveCount(0, { timeout: 15000 });
        await page.getByRole("button", { name: /Agent 决策/ }).click();
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill("请查询外部新闻，不是楼宇问题");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        const web = page.locator('[data-tool="web_search"]');
        await expect(web).toContainText("联网查询中");
        await expect(web.locator("svg ellipse")).toHaveCount(1);
        await expect(web.locator(".agent-step-dots > span")).toHaveCount(3);
        await web.evaluate((e) => ((window as any).originalStep = e));
        const effect = await web.evaluate((e) => ({
          sweep: getComputedStyle(e, "::after").animationName,
          dot: getComputedStyle(e.querySelector(".agent-step-dots > span")!)
            .animationName,
          duration: getComputedStyle(e, "::after").animationDuration,
        }));
        expect(effect.sweep).toBe(
          motion === "reduce" ? "none" : "agent-step-sweep",
        );
        expect(effect.dot).toBe(
          motion === "reduce" ? "none" : "agent-step-dot",
        );
        if (motion === "no-preference") expect(effect.duration).toBe("1.4s");
        await expect(web).toHaveAttribute("data-tool-state", "done");
        await expect(web).toContainText("✓");
        await expect(web).toContainText("联网查询");
        await expect(web).toContainText("1.6 s");
        expect(
          await web.evaluate((e) => e === (window as any).originalStep),
        ).toBe(true);
        const wait = page.locator('[data-progress-id="chat-answer-wait"]');
        await expect(wait).toContainText("正在组织回答，已等待 2 秒");
        await expect(wait.locator(".agent-step-line")).toHaveCount(1);
        const aligned = await page
          .locator(".agent-step-line")
          .evaluateAll((es) =>
            es.map(
              (e) =>
                e.querySelector(".agent-step-label")!.getBoundingClientRect()
                  .left,
            ),
          );
        expect(new Set(aligned.map((x) => Math.round(x))).size).toBe(1);
        await expect(
          page.getByRole("textbox", { name: "运维问题" }),
        ).toBeEnabled({ timeout: 15000 });
        await expect(wait).toHaveCount(0);
        await expect(page.locator(".agent-answer-text")).toContainText(
          "这是一条联网回答。",
        );
        await expect(page.locator(".agent-answer-text a")).toHaveCount(1);
        await expect(page.locator(".agent-answer-text a")).toHaveAttribute(
          "href",
          "https://example.com/report",
        );
        await expect(page.locator(".agent-answer-sources a")).toHaveAttribute(
          "href",
          "https://example.com/report",
        );
        expect(
          await page
            .locator(".agent-answer-sources")
            .evaluate((e) =>
              e.previousElementSibling?.classList.contains("agent-answer-text"),
            ),
        ).toBe(true);
        expect(question).toBe("请查询外部新闻，不是楼宇问题");
        await page.getByRole("textbox", { name: "运维问题" }).fill("下一题");
        await expect(
          page.getByRole("button", { name: "发送", exact: true }),
        ).toBeEnabled();
      });
    });
