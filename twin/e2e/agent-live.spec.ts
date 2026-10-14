import { ChatMarkdown } from "../src/pages/agent/ChatMarkdown";
import { DESKTOP_125 } from "./viewport-profile";
import { test, expect, type Page } from "@playwright/test";
import {
  storagePower,
  storageLabel,
  storageMode,
} from "../src/pages/agent/data";
import { assertShellScrolling } from "./shell-scroll-policy";
// Text contract: only U+0020 or U+00A0 is accepted for an existing space.
// Never erase whitespace or replace missing text spaces with CSS geometry.
async function assertStorageMetric(page: Page, expected: string) {
  const metric = page.locator(".agent-plan li").last().locator(".agent-plan-number");
  await expect.poll(async () => ((await metric.textContent()) ?? "").replace(/\u00a0/g, " "))
    .toBe(expected);
}
// Playwright transforms JSX to its own element objects; project text without React SSR.
// This oracle reads only the backend wire and the documented Markdown presentation.
function markdownText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownText).join("");
  const element = node as { type: unknown; props: { children?: unknown } };
  if (typeof element.type === "function") return markdownText(element.type(element.props));
  return markdownText(element.props.children);
}
const live = process.env.AGENT_LIVE_URL;
for (const viewport of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`${viewport.width} DPR ${viewport.dpr}`, () => {
    test.use({ deviceScaleFactor: viewport.dpr });
    test.describe(`viewport ${viewport.width}x${viewport.height}@${viewport.dpr ?? 1}`, () => {
      test.use({ deviceScaleFactor: viewport.dpr ?? 1 });
      test(`live Agent ${viewport.width}: real SSE and layout`, async ({
        page,
      }, info) => {
        test.skip(!live, "Opt-in real service regression: AGENT_LIVE_URL");
        test.setTimeout(90000);
        await page.setViewportSize(viewport);
        const url = new URL(live!);
        url.searchParams.set("scenario", "peak");
        url.searchParams.set("at", "2026-10-12T14:00");
        const scheduled = page.waitForResponse(
          (r) =>
            r.url().endsWith("/schedule") && r.request().method() === "POST",
        );
        // Observe a cloned stream in-page: Chromium CDP may evict SSE response bodies.
        await page.addInitScript(() => {
          const original = window.fetch;
          window.fetch = async (...args) => {
            const response = await original(...args);
            if (response.url.includes("/chat/stream"))
              (window as any).__chatWire = response.clone().text();
            return response;
          };
        });
        await page.goto(url.toString());
        await page.getByRole("button", { name: "预测与风险" }).click();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        if (viewport.width >= 1366) {
          await assertShellScrolling(
            page,
            "live forecast: main may scroll vertically",
          );
          for (const overflow of await page
            .locator(".forecast-page > .card,.forecast-model-scroll")
            .evaluateAll((es) =>
              es.map((e) => e.scrollHeight - e.clientHeight),
            ))
            expect(overflow).toBeLessThanOrEqual(1);
        }
        await page.screenshot({
          path: info.outputPath("forecast.png"),
          fullPage: viewport.width === 390,
        });
        await info.attach("live-forecast", {
          path: info.outputPath("forecast.png"),
          contentType: "image/png",
        });
        for (const summary of await page
          .locator(".forecast-details summary")
          .all())
          await summary.click();
        expect(await page.locator(".forecast-root").innerText()).not.toMatch(
          /(?<!\d)201[67](?![\d.,])/,
        );
        for (const summary of await page
          .locator(".forecast-details summary")
          .all())
          await summary.click();
        await page.getByRole("button", { name: "Agent 决策" }).click();
        const schedule = await scheduled;
        expect(schedule.status()).toBe(200);
        const raw = await schedule.json();
        expect(raw.candidates.length).toBeGreaterThanOrEqual(2);
        const plans = raw.candidates.map(
          (c: {
            plan: {
              timestamp: string;
              hvac_setpoint_c: number;
              battery_kw: number;
              action: string;
            }[];
          }) =>
            JSON.stringify(
              c.plan.map((p) => [
                p.timestamp,
                p.hvac_setpoint_c,
                p.battery_kw,
                p.action,
              ]),
            ),
        );
        expect(new Set(plans).size).toBe(plans.length);
        await info.attach("live-candidates", {
          body: JSON.stringify(raw.candidates),
          contentType: "application/json",
        });
        expect(await page.evaluate(() => devicePixelRatio)).toBe(viewport.dpr);
        await expect(page.locator(".timeline")).toHaveAttribute(
          "data-time",
          "14",
        );
        await expect(page.locator(".agent-root")).toBeVisible();
        await expect(page.locator(".agent-request-status")).not.toContainText(
          "接口查询中",
          { timeout: 50000 },
        );
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator(".agent-tags")).toContainText("LLM 在线");
        await expect(page.locator(".agent-root")).toHaveAttribute(
          "data-decision-source",
          "schedule",
        );
        const currentOrigin = await page
          .locator(".agent-root")
          .getAttribute("data-origin");
        const current = raw.plan.find(
          (p: { timestamp: string }) =>
            Date.parse(p.timestamp) === Date.parse(currentOrigin!),
        );
        await assertStorageMetric(page, storagePower(current.battery_kw));
        await expect(
          page.locator(".agent-plan li").last().locator(".agent-plan-number"),
        ).toContainText(storageMode(current.battery_kw));
        for (const [i, c] of raw.candidates.entries()) {
          const p = c.plan.find(
            (p: { timestamp: string }) =>
              Date.parse(p.timestamp) === Date.parse(currentOrigin!),
          );
          await expect(
            page.locator(".agent-candidate-storage").nth(i),
          ).toContainText(storageLabel(p.battery_kw));
          await expect(
            page.locator(".agent-candidate-storage").nth(i),
          ).toContainText(storageMode(p.battery_kw));
        }
        await expect(page.locator(".agent-decision-source")).toHaveText(
          raw.source === "llm" ? "LLM 决策" : "规则决策",
        );
        // 906a264: decision badge title describes wording, not decision source.
        await expect(page.locator(".agent-decision-source")).toHaveAttribute(
          "title",
          raw.explanation_source === "llm"
            ? "LLM 措辞"
            : raw.explanation_source === "template"
              ? "模板措辞"
              : "措辞来源未提供",
        );
        const windowHours = raw.candidates[0].plan.length;
        expect(windowHours).toBe(24);
        await expect(page.locator(".agent-comparison header small")).toHaveText(
          `${windowHours} 小时窗口合计`, // dfb39cc: comparison header owns scope
        );
        // Wait for presentation-only tweens and the chart's lazy update before capture.
        await page.waitForTimeout(400);
        const details = await page.locator(".agent-root").evaluate((e) => ({
          root: e.getBoundingClientRect().toJSON(),
          nodes: [
            ...e.querySelectorAll(
              ".agent-plan-column,.agent-plan p,.agent-chart-block,.agent-chart-block h3,.agent-auto-grid > .agent-steps,.agent-auto-grid > .agent-steps > li,.agent-record-card,.agent-table-scroll,.agent-table-scroll table",
            ),
          ].map((n) => ({
            cls: n.className,
            rect: n.getBoundingClientRect().toJSON(),
            h: n.clientHeight,
            sh: n.scrollHeight,
            w: n.clientWidth,
            sw: n.scrollWidth,
            overflow: getComputedStyle(n).overflow,
          })),
        }));
        await info.attach("live-layout", {
          body: JSON.stringify(details),
          contentType: "application/json",
        });
        await page.screenshot({
          path: info.outputPath("agent-before.png"),
          fullPage: viewport.width === 390,
        });
        await info.attach("live-before", {
          path: info.outputPath("agent-before.png"),
          contentType: "image/png",
        });
        if (viewport.width >= 1366) {
          // dfb39cc: evidence-first decision card, not the removed plan/chart column.
          const plan = await page.locator(".agent-plan").boundingBox();
          const evidence = await page
            .locator(".agent-evidence-row")
            .boundingBox();
          expect(plan!.y + plan!.height).toBeLessThanOrEqual(evidence!.y + 1);
          await assertShellScrolling(
            page,
            "live agent: main may scroll vertically",
          );
          const record = await page
            .locator(".agent-record-card .agent-table-scroll")
            .evaluate((e) => ({
              y: e.scrollHeight - e.clientHeight,
              x: e.scrollWidth - e.clientWidth,
            }));
          expect(record.y).toBeLessThanOrEqual(1);
          expect(record.x).toBeLessThanOrEqual(1);
          const root = await page.locator(".agent-root").boundingBox();
          const chat = await page.locator(".agent-chat-card").boundingBox();
          expect(
            Math.abs(root!.y + root!.height - chat!.y - chat!.height),
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(root!.x + root!.width - chat!.x - chat!.width),
          ).toBeLessThanOrEqual(1);
          const heading = await page
            .locator(".agent-comparison header")
            .boundingBox();
          const table = await page
            .locator(".agent-comparison table")
            .boundingBox();
          expect(heading!.y + heading!.height).toBeLessThanOrEqual(
            table!.y + 1,
          );
        }
        const response = page.waitForResponse((r) =>
          r.url().endsWith("/chat/stream"),
        );
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill("未来24小时峰值是多少？");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        const stream = await response;
        expect(stream.status()).toBe(200);
        expect(stream.headers()["content-type"]).toContain("text/event-stream");
        const process = page.locator(".agent-chat-process").last();
        await expect(process.locator("summary")).toContainText("已调用", {
          timeout: 60000,
        });
        const wire = await page.evaluate(
          async () => (await (window as any).__chatWire) as string,
        );
        const events = wire
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.some((e) => e.type === "done")).toBe(true);
        const answer = events
          .filter((e) => e.type === "answer_delta")
          .map((e) => e.text)
          .join("");
        expect(answer).not.toBe("");
        // 25d2f70 supports Markdown: compare the SSE's rendered text, not raw ** markers.
        // The expected value comes only from the observed wire, never the answer DOM.
        const expectedText = markdownText(ChatMarkdown({ text: answer }));
        await expect.poll(async () =>
          ((await page.locator(".agent-answer-text").last().textContent()) ?? "").replace(/\u00a0/g, " "),
        ).toBe(expectedText.replace(/\u00a0/g, " "));
        // 25d2f70/ChatProcess defaults expanded; do not accidentally collapse it.

        if ((await process.getAttribute("open")) === null)
          await process.locator("summary").click();
        await expect(
          process.locator("[data-tool-state=done]").first(),
        ).toBeVisible();
        expect(await page.locator(".agent-root").innerText()).not.toMatch(
          /(?<!\d)201[67](?![\d.,])/,
        );
        await info.attach("live-stream-text", {
          body: JSON.stringify({
            answer: await page.locator(".agent-answer-text").last().innerText(),
            steps: await process.innerText(),
          }),
          contentType: "application/json",
        });
        await page.screenshot({
          path: info.outputPath("agent-after.png"),
          fullPage: viewport.width === 390,
        });
        await info.attach("live-after", {
          path: info.outputPath("agent-after.png"),
          contentType: "image/png",
        });
      });
    });
  });
}
