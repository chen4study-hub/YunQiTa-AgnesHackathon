import { DESKTOP_125 } from "./viewport-profile";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import {
  decisionReasonLabel,
  costWindowLabel,
  decisionSourceLabel,
  scheduleDecision,
  storageLabel,
  storageMode,
  storagePower,
} from "../src/pages/agent/data";
import { replayCalendar } from "../src/ui/replayCalendar";
import { formatDisplayDate } from "../src/config/presentation";
import { seekPageHour } from "./page-seek";
import { reasonPreview } from "../src/pages/agent/PlanReason";
import { assertDisplayText } from "./agent-forecast-visible";

import { assertShellScrolling } from "./shell-scroll-policy";
// Text contract: only U+0020 or U+00A0 is accepted for an existing space.
// Never erase whitespace or replace missing text spaces with CSS geometry.
async function assertStorageMetric(page: Page, expected: string) {
  const metric = page.locator(".agent-plan li").last().locator(".agent-plan-number");
  await expect.poll(async () => ((await metric.textContent()) ?? "").replace(/\u00a0/g, " "))
    .toBe(expected);
}
const live = process.env.AGENT_LIVE_URL;
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
];
const days = [
  { scenario: "normal", name: "工作日" },
  { scenario: "peak", name: "高温日" },
  { scenario: "abstain", name: "节假日" },
] as const;
async function scan(page: Page) {
  const text = await page.locator("main").evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (
        !el ||
        el.closest("style,script") ||
        !el.checkVisibility({ checkVisibilityCSS: true })
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (range.getClientRects().length && node.textContent?.trim())
        parts.push(node.textContent);
    }
    return parts.join("\n");
  });
  // Match year tokens but not legitimate numeric measurements (e.g. 2,017.0 kW).
  expect(text).not.toMatch(/(?<!\d)201[67](?![\d.,])/);
  await assertDisplayText(page);
  return text;
}
async function layout(
  page: Page,
  root: string,
  desktop: boolean,
  info: TestInfo,
  name: string,
) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const report = await page.locator(root).evaluate((e) => ({
    h: e.clientHeight,
    sh: e.scrollHeight,
    w: e.clientWidth,
    sw: e.scrollWidth,
    nodes: [
      ...e.querySelectorAll(
        ".card,.forecast-model-scroll,.forecast-chart-column,.agent-table-scroll,.forecast-table-scroll,.agent-chart-block",
      ),
    ]
      .filter((n) => n.checkVisibility({ checkVisibilityCSS: true }))
      .map((n) => ({
        cls: n.className,
        h: n.clientHeight,
        sh: n.scrollHeight,
        w: n.clientWidth,
        sw: n.scrollWidth,
        overflow: getComputedStyle(n).overflowY,
        rect: n.getBoundingClientRect().toJSON(),
      })),
  }));
  await info.attach(`${name}-layout`, {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
  expect(report.sw - report.w).toBeLessThanOrEqual(1);
  if (desktop) {
    await assertShellScrolling(page, `${root}: main may scroll vertically`);
    for (const n of report.nodes) {
      expect(
        n.sh - n.h,
        `${n.cls}: no vertical crop or in-card scroll`,
      ).toBeLessThanOrEqual(1);
      expect(n.sw - n.w, `${n.cls}: no horizontal crop`).toBeLessThanOrEqual(1);
      // Main may scroll; card crop checks above remain.
    }
  } else {
    await assertShellScrolling(page, `${root}: intrinsic mobile height`);
    for (const n of report.nodes.filter((n) =>
      n.cls.toString().includes("card"),
    ))
      expect(n.sh - n.h).toBeLessThanOrEqual(1);
  }
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: !desktop,
  });
  await info.attach(name, {
    path: info.outputPath(`${name}.png`),
    contentType: "image/png",
  });
}

for (const size of sizes)
  test.describe(`final ${size.width} DPR ${size.dpr}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    for (const { scenario } of days)
      test(`${scenario}: new replay, live schedule and SSE on both pages`, async ({
        page,
      }, info) => {
        test.skip(!live, "Opt-in real service regression: AGENT_LIVE_URL");
        test.setTimeout(120000);
        const data = JSON.parse(
          readFileSync(`public/replay/${scenario}.json`, "utf8"),
        ) as ReplayData;
        const responses: unknown[] = [];
        const desktop = size.width >= 1366;
        const url = new URL(live!);
        url.searchParams.set("scenario", scenario);
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
        await expect(page.locator(".forecast-root")).toBeVisible();
        await expect(page.locator(".bottombar .clock")).toContainText(
          formatDisplayDate(new Date(2026, 9, 12, 14)),
        );
        expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
        await layout(page, ".forecast-root", desktop, info, "forecast");
        await scan(page);
        for (const summary of await page
          .locator(".forecast-details summary")
          .all())
          await summary.click();
        await info.attach("forecast-expanded-text", {
          body: await scan(page),
          contentType: "text/plain",
        });
        await expect(page.locator(".forecast-root")).toContainText("次日");
        for (const summary of await page
          .locator(".forecast-details summary")
          .all())
          await summary.click();
        await page.getByRole("button", { name: "Agent 决策" }).click();
        const initial = await scheduled;
        expect(initial.status()).toBe(200);
        let raw = await initial.json();
        // Both discharge (14:00) and charging (01:00) get real schedules; refused day uses safe standby.
        for (const hour of [14, 1]) {
          if (hour !== 14) {
            const pending = page.waitForResponse(
              (r) =>
                r.url().endsWith("/schedule") &&
                r.request().method() === "POST" &&
                r.request().postDataJSON().start === data.hours[hour].t,
            );
            await seekPageHour(page, hour);
            const response = await pending;
            expect(response.status()).toBe(200);
            raw = await response.json();
          }
          await expect(page.locator(".agent-root")).toHaveAttribute(
            "data-origin",
            data.hours[hour].t,
          );
          await expect(page.locator(".agent-root")).toHaveAttribute(
            "data-decision-source",
            "schedule",
            { timeout: 50000 },
          );
          await expect(page.locator(".agent-request-status")).not.toContainText(
            "接口查询中",
            { timeout: 50000 },
          );
          await expect(page.locator(".agent-tags")).toContainText("LLM 在线");
          const d = scheduleDecision(raw, data, hour);
          expect(d).not.toBeNull();
          await expect(page.locator(".agent-decision-source")).toHaveText(
            decisionSourceLabel(d!),
          );
          responses.push(raw);
          const show = replayCalendar(
            scenario,
            data.hours[hour].t,
            new Date(2026, 9, 12, 14),
          ).text;
          // A refused window returns just the conservative handoff candidate.
          expect(raw.candidates.length).toBeGreaterThanOrEqual(
            d!.handoff ? 1 : 2,
          );
          expect(raw.candidates[0].plan.length).toBe(24);
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
          expect(d!.candidates.map((c) => c.id)).toContain(d!.selected);
          if (d!.handoff) {
            expect(d!.battery).toBe(0);
            // dfb39cc/1.5: ticket is lazy-loaded inside its dialog, not a card.
            await page
              .getByRole("button", { name: "查看人工工单", exact: true })
              .click();
            const ticketDialog = page.getByRole("dialog", { name: "人工工单" });
            await expect(ticketDialog.locator(".agent-ticket")).toContainText(
              "待机",
            );
            await expect(ticketDialog.locator("h3")).toContainText("人工工单");
            await page.keyboard.press("Escape");
            await expect(
              page.locator(".agent-reason-section .agent-reason-preview"),
            ).toHaveText(reasonPreview(show(decisionReasonLabel(d!))));
            await page.getByRole("button", { name: "展开调度理由" }).click();
            await expect(page.locator(".agent-reason-full")).toHaveText(
              show(decisionReasonLabel(d!)),
            );
            await scan(page);
            await page.keyboard.press("Escape");
            // Schedule has no ticket ID; loaded replay details own the ticket.
            expect(d!.ticket.id).toBe("暂无数据");
            // dfb39cc: handoff risk evidence replaces the old risk chart.
            await expect(page.locator(".agent-handoff-summary")).toContainText(
              "风险评分",
            );
            await expect(page.locator(".agent-handoff-summary")).toContainText(
              "候选评估已暂停，自动下发已停止。",
            );
          } else {
            const metric = page.locator(".agent-plan li").last();
            await assertStorageMetric(page, storagePower(d!.battery));
            await expect(metric.locator(".agent-plan-number")).toContainText(
              storageMode(d!.battery),
            );
            // LLM may legitimately select hold. Signs are checked against the real selected command,
            // while candidate alternatives cover charge/discharge rather than imposing a choice.
            expect(
              d!.candidates.some(
                (c) =>
                  storageMode(c.battery) === (hour === 1 ? "充电" : "放电"),
              ),
            ).toBe(true);
            for (const [i, c] of d!.candidates.entries()) {
              const row = page.locator(".agent-candidate-storage").nth(i);
              await expect(row).toContainText(storageLabel(c.battery));
              await expect(row).toContainText(storageMode(c.battery));
            }
            await expect(page.locator(".agent-selected th")).toContainText(
              d!.candidates.find((c) => c.id === d!.selected)!.name,
            );
            await expect(
              page.locator(".agent-comparison header small"),
            ).toHaveText(costWindowLabel(d!)); // dfb39cc: window metadata in comparison header
            await page.getByRole("button", { name: "展开调度理由" }).click();
            await expect(page.locator(".agent-reason-full")).toHaveText(
              show(decisionReasonLabel(d!)),
            );
            expect((await scan(page)).length).toBeGreaterThan(100);
            await page.keyboard.press("Escape");
          }
          const record = page.locator(".agent-record-card tbody tr").first();
          await expect(record).toContainText(
            d!.handoff ? "预测拒绝" : `储能 ${storagePower(d!.battery)}`,
          );
          // ba8b67a: the record stores action/state separately; preserve both.
          if (d!.handoff) await expect(record).toContainText("待处理");
          await layout(page, ".agent-root", desktop, info, `agent-${hour}`);
          await info.attach(`agent-${hour}-text`, {
            body: await scan(page),
            contentType: "text/plain",
          });
        }
        await info.attach("schedules", {
          body: JSON.stringify(responses),
          contentType: "application/json",
        });
        const streamed = page.waitForResponse((r) =>
          r.url().endsWith("/chat/stream"),
        );
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill("未来24小时峰值是多少？");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        const stream = await streamed;
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
        await expect(page.locator(".agent-answer-text").last()).toHaveText(
          answer,
        );
        // 25d2f70/ChatProcess defaults expanded; do not accidentally collapse it.

        if ((await process.getAttribute("open")) === null)
          await process.locator("summary").click();
        await expect(
          process.locator("[data-tool-state=done]").first(),
        ).toBeVisible();
        await info.attach("agent-stream-text", {
          body: await scan(page),
          contentType: "text/plain",
        });
        await page.screenshot({
          path: info.outputPath("agent-stream.png"),
          fullPage: !desktop,
        });
        await info.attach("agent-stream", {
          path: info.outputPath("agent-stream.png"),
          contentType: "image/png",
        });
      });
  });
