import { test, expect } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { currentUI4183 } from "./agent-local-ui-4183";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
// Basic Markdown markers are rendered, not literal answer content. Exact source
// bytes are checked separately in persisted history, so no wording can be lost.
const visibleAnswer = (s: string) => s
  .replace(/^\s{0,3}(?:-|\+|\*|\d+\.)\s+/gm, "")
  .split("**").join("").split("*").join("").split("`").join("");
for (const fallback of [false, true])
  test(`peak answer preserved with human-review label ${fallback ? "JSON fallback" : "real SSE"} on test backend`, async ({
    page,
  }, info) => {
    await currentUI4183(page);
    if (fallback)
      await page.route("**/api/chat/stream", (r) =>
        r.fulfill({ status: 404, body: "" }),
      );
    let raw = "",
      answer = "",
      needs = false;
    await page.addInitScript(() => {
      (window as any).chatRaw = {};
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        const url = String(args[0]);
        if (url.endsWith("/chat") || url.endsWith("/chat/stream"))
          void response
            .clone()
            .text()
            .then((text) => ((window as any).chatRaw[url] = text));
        return response;
      };
    });
    await page.goto("/?scenario=normal&at=2026-10-13T14:00", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-chat-form")).toBeVisible();
    await page
      .getByRole("button", { name: "未来24小时峰值是多少？", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled({
      timeout: 60000,
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as any).chatRaw["/api/chat"] ??
              (window as any).chatRaw["/api/chat/stream"],
          ),
        { timeout: 60000 },
      )
      .not.toBeUndefined();
    if (fallback)
      await expect
        .poll(() => page.evaluate(() => (window as any).chatRaw["/api/chat"]), {
          timeout: 60000,
        })
        .not.toBeUndefined();
    const captured = await page.evaluate(() => (window as any).chatRaw);
    raw = captured["/api/chat"] ?? captured["/api/chat/stream"];
    if (captured["/api/chat"]) {
      const v = JSON.parse(raw);
      answer = v.answer;
      needs = v.needs_human;
    } else {
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const v = JSON.parse(line.slice(5));
        if (v.type === "answer_delta") answer += v.text;
        if (v.type === "done") needs = v.needs_human;
      }
    }
    expect(answer.trim().length).toBeGreaterThan(0);
    expect(needs).toBe(true);
    const bubble = page.locator(".agent-assistant").last();
    await expect(bubble.locator(".agent-answer-text")).toHaveText(visibleAnswer(answer), {
      timeout: 50000,
    });
    await expect(bubble.locator(".agent-answer-review")).toHaveText(
      "需值班人员复核",
    );
    await expect(bubble).not.toContainText("数据不足，已转人工");
    await expect(bubble.locator(".agent-chat-process")).not.toContainText(
      "起报",
    );
    await expect(bubble.locator(".agent-chat-process")).not.toContainText(
      "逐步预测",
    );
    await page.screenshot({ path: info.outputPath("peak-review.png") });
    await info.attach("backend-chat-response", {
      body: raw,
      contentType: fallback ? "application/json" : "text/plain",
    });
    console.log(JSON.stringify({ fallback, needs, answer }));
    const savedAnswer = await page.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem("yunqi-agent-chat-v1")!);
      return saved.messages.filter((m: any) => m.role === "assistant").at(-1).text;
    });
    expect(savedAnswer).toBe(answer);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(
      page.locator(".agent-assistant").last().locator(".agent-answer-text"),
    ).toHaveText(visibleAnswer(answer));
    await expect(
      page.locator(".agent-assistant").last().locator(".agent-answer-review"),
    ).toHaveText("需值班人员复核");
  });

for (const mode of ["llm", "fallback"])
  for (const transport of ["sse", "json"])
    test(`verbatim ${mode} ${transport}, including empty human-review answer`, async ({
      page,
    }) => {
      await currentUI4183(page);
      let answer = " 后端原文：2017-01-01T14:00:00Z，数据不足由后端自行决定。 ";
      await page.route("**/api/chat/stream", async (r) => {
        if (transport === "json") return r.fulfill({ status: 404, body: "" });
        return r.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "answer_delta", text: answer },
            {
              type: "done",
              mode,
              grounded: false,
              known: false,
              needs_human: true,
            },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join("")
            .replaceAll("\\n", "\n"),
        });
      });
      await page.route("**/api/chat", (r) =>
        r.fulfill({
          json: {
            answer,
            mode,
            grounded: false,
            known: false,
            needs_human: true,
            reason: "no_data",
            origin: "other",
          },
        }),
      );
      await page.goto("/?scenario=normal&at=2026-10-13T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(page.locator(".agent-chat-form")).toBeVisible();
      for (const text of [answer, ""]) {
        answer = text;
        await page
          .getByRole("button", { name: "未来24小时峰值是多少？", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "运维问题" }),
        ).toBeEnabled();
        const bubble = page.locator(".agent-assistant").last();
        if (answer)
          await expect(bubble.locator(".agent-answer-text")).toHaveText(answer);
        else {
          await expect(bubble.locator(".agent-answer-text")).toHaveCount(0);
          await expect(bubble).not.toContainText("数据不足，已转人工");
          await expect(bubble).not.toContainText("没能拿到");
        }
      }
    });
