import { test, expect } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const width of [1366, 390]) {
  test(`SSE ${width}: ordered live tools, timer, deltas and collapsed completion`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type,accept");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.url !== "/chat/stream") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ type: "step", text: "第一步：核对当前记录" });
      send({ type: "tool_start", tool: "get_forecast", args: { horizon: 24 } });
      await delay(2300);
      send({
        type: "tool_end",
        tool: "get_forecast",
        ms: 2300,
        summary: "预测记录已核对",
      });
      for (const tool of ["get_context", "forecast_peak"]) {
        send({ type: "tool_start", tool, args: {} });
        await delay(200);
        send({ type: "tool_end", tool, ms: 200, summary: `${tool} 已完成` });
      }
      for (let i = 0; i < 20; i++)
        send({ type: "step", text: `核验记录 ${i}` });
      send({ type: "answer_delta", text: "已核验的第一段。" });
      await delay(1100);
      send({ type: "answer_delta", text: "这是第二段回答。" });
      await delay(500);
      send({ type: "done", known: true, needs_human: false, grounded: true });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      await page.goto(
        `/?source=file&scenario=normal&at=2026-10-12T14:00&api=${encodeURIComponent(`http://127.0.0.1:${port}`)}`,
      );
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      const card = page.locator(".agent-chat-card");
      const before = await card.boundingBox();
      await page.getByRole("textbox", { name: "运维问题" }).fill("未来峰值？");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const process = page.locator(".agent-chat-process");
      await expect(process.locator("li").first()).toHaveText(
        "第一步：核对当前记录",
      );
      await expect(
        process.locator('[data-tool-state="running"]'),
      ).toContainText("负荷预测查询");
      // 070981e preserves duration decimals. Poll while the tool is pending,
      // rather than missing the old integer-copy match and waiting until done.
      await expect(process.locator("summary")).toContainText(/已用 (?:[1-9]\d*\.\d s|[1-9]\d*(?:\.\d)? ms)/);
      await expect(
        process.locator('[data-tool-state="done"]').first(),
      ).toContainText("2.3 s");
      await expect(page.locator(".agent-answer-text")).toHaveText(
        "已核验的第一段。",
      );
      await expect(page.locator(".agent-answer-text")).toHaveText(
        "已核验的第一段。这是第二段回答。",
      );
      await expect(process).toHaveAttribute("open", "");
      await expect(process.locator("summary")).toContainText("已调用 3 个工具");
      await expect(process).toHaveAttribute("open", "");
      expect(
        await process
          .locator(".agent-process-tool .agent-step-label")
          .allTextContents(),
      ).toEqual(["负荷预测查询", "运行上下文查询", "峰值计算"]);
      expect(
        await process
          .locator(".agent-process-list")
          .evaluate((e) => e.scrollHeight > e.clientHeight),
      ).toBe(true);
      for (const font of await process
        .locator("li,code,small")
        .evaluateAll((es) =>
          es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
        ))
        expect(font).toBeGreaterThanOrEqual(11);
      const after = await card.boundingBox();
      if (width === 390) {
        expect(after!.height).toBeGreaterThan(before!.height);
        expect(after!.height).toBeLessThan(700);
      } else expect(after!.height).toBeCloseTo(before!.height, 0);
      await test.info().attach(`sse-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}

test("404 fallback rotates progress with elapsed seconds and returns /chat answer", async ({
  page,
}) => {
  let streamCalls = 0,
    chatCalls = 0;
  await page.route("**/api/**", async (route) => {
    if (route.request().url().endsWith("/chat/stream")) {
      streamCalls++;
      return route.fulfill({ status: 404 });
    }
    if (!route.request().url().endsWith("/chat")) return route.abort();
    chatCalls++;
    await delay(4300);
    return route.fulfill({
      json: {
        answer: "普通接口回答",
        known: true,
        grounded: true,
        tool_trace: [{ tool: "get_forecast" }],
      },
    });
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await page.getByRole("textbox", { name: "运维问题" }).fill("峰值？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const summary = page.locator(".agent-chat-process summary");
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
  await expect(
    page.locator('[data-progress-id="chat-answer-wait"]'),
  ).toHaveCount(0);
  await expect(page.locator(".agent-answer-text")).toHaveText("普通接口回答", {
    timeout: 15000,
  });
  await expect(summary).toContainText("已调用 1 个工具");
  expect(streamCalls).toBe(1);
  expect(chatCalls).toBe(1);
});

test("explicit stream errors release input without fallback and preserve received backend text", async ({
  page,
}) => {
  let legacyCalls = 0;
  await page.route("**/api/**", async (route) => {
    if (route.request().url().endsWith("/chat")) {
      legacyCalls++;
      return route.abort();
    }
    if (!route.request().url().endsWith("/chat/stream")) return route.abort();
    return route.fulfill({
      contentType: "text/event-stream",
      body: [
        { type: "tool_start", tool: "get_context", args: {} },
        { type: "answer_delta", text: "未完成回答" },
        { type: "error", message: "工具记录暂不可用" },
        { type: "done", known: false, needs_human: true, grounded: true },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
    });
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  await page.getByRole("textbox", { name: "运维问题" }).fill("查询？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-answer-text")).toHaveText("未完成回答");
  await expect(page.locator(".agent-answer-text")).not.toContainText(
    "这次没能拿到可核验的数据，请稍后再试。",
  );
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled();
  await expect(page.locator(".agent-process-error")).toHaveText(
    "工具记录暂不可用",
  );
  await expect(page.locator(".agent-tool-spinner")).toHaveCount(0);
  expect(legacyCalls).toBe(0);
});
