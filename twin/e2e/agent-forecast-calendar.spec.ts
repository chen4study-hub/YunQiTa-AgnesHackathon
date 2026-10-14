import { DESKTOP_125 } from "./viewport-profile";
import { replayWithAgentDetails } from "./replay-agent-fixture";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { formatDisplayDate } from "../src/config/presentation";
import { forbiddenDisplayText } from "./agent-forecast-visible";
const sourceYears = /(?<!\d)201[67](?![\d.,])/;
async function assertCalendarDisplay(page: Page) {
  // Chat persists across navigation. Exempt only the three exact mock answers;
  // 25d2f70 requires preserving them, while calendar-owned UI is still audited.
  const originals=["normal","peak","abstain"].map(scenario=>{
    const raw=replayWithAgentDetails(scenario as "normal"|"peak"|"abstain");
    return `${raw.hours[14].t} 下发；${raw.hours[15].t} 峰值。`;
  });
  expect((await forbiddenDisplayText(page)).filter(text=>!originals.includes(text))).toEqual([]);
}
async function visibleText(page: Page) {
  return page.locator("main").evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (
        !el ||
        // 25d2f70 preserves backend answer verbatim; audit calendar-owned UI only.
        el.closest("style,script,.agent-answer-text") ||
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
}
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`calendar ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("visible dates in both pages, expanded tables, work orders and streamed answers use shell calendar", async ({
      page,
    }, info) => {
      test.setTimeout(60000);
      const payloads: {
        scenario: string;
        origin?: string;
        start?: string;
        display_date?: string;
      }[] = [];
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/health"))
          return route.fulfill({ json: { llm: { mode: "real" } } });
        if (route.request().method() !== "POST") return route.abort();
        const body = route.request().postDataJSON();
        payloads.push(body);
        if (path.endsWith("/schedule")) {
          const data = replayWithAgentDetails(body.scenario);
          const h = data.hours.find((h: { t: string }) => h.t === body.start),
            a = h.agent;
          const selected = a.candidates.find(
            (c: { candidate_id: string }) => c.candidate_id === a.selected,
          );
          return route.fulfill({
            json: {
              building_id: data.meta.building_id,
              plan: selected.plan,
              candidates: a.candidates,
              selected: a.selected,
              source: a.source,
              explanation_source: a.explanation_source,
              reason: `${h.t} 当前指令；${data.hours[15].t} 后续检查。`,
              work_orders: h.abstain
                ? [
                    {
                      timestamp: h.t,
                      id: `YQ-${h.t.slice(0, 10).replaceAll("-", "")}-14`,
                      possible_reasons: [`${h.t} 门控拒绝`],
                      suggested_checks: [`${h.t} 核对表计`],
                    },
                  ]
                : [],
              receipt: a.receipt,
            },
          });
        }
        if (path.endsWith("/chat/stream")) {
          const data = replayWithAgentDetails(body.scenario);
          const origin = data.hours[14].t;
          return route.fulfill({
            contentType: "text/event-stream",
            body: [
              { type: "step", text: `${origin} 开始查询` },
              { type: "tool_start", tool: "get_forecast", args: {} },
              {
                type: "tool_end",
                tool: "get_forecast",
                ms: 1,
                summary: `${origin} 核验记录`,
              },
              { type: "answer_delta", text: `${origin} 下发；` },
              { type: "answer_delta", text: `${data.hours[15].t} 峰值。` },
              { type: "done", known: true, grounded: true, needs_human: false },
            ]
              .map((e) => `data: ${JSON.stringify(e)}\n\n`)
              .join(""),
          });
        }
        return route.abort();
      });
      for (const scenario of ["normal", "peak", "abstain"] as const) {
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
        );
        await page.getByRole("button", { name: "预测与风险" }).click();
        await expect(page.locator(".forecast-root")).toBeVisible();
        for (const summary of await page
          .locator(".forecast-details summary")
          .all())
          await summary.click();
        const forecast = await visibleText(page);
        expect(forecast).not.toMatch(sourceYears);
        await assertCalendarDisplay(page);
        expect(forecast).toContain("模型指标");
        expect(forecast).not.toContain("评估口径与模型详情");
        expect(forecast).toContain("次日");
        await page.getByRole("button", { name: "Agent 决策" }).click();
        await expect(page.locator(".agent-root")).toHaveAttribute(
          "data-decision-source",
          "schedule",
        );
        const display = formatDisplayDate(new Date(2026, 9, 12, 14)).slice(
          0,
          10,
        );
        if (scenario !== "abstain") {
          await page.getByRole("button", { name: "展开调度理由" }).click();
          expect(await visibleText(page)).not.toMatch(sourceYears);
          await expect(page.locator(".agent-reason-full")).toContainText(
            `${display} 14:00`,
          );
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "查看执行回执" }).click();
          await expect(
            page.getByRole("dialog", { name: "执行回执" }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
        } else {
          await page.getByRole("button", { name: "查看人工工单" }).click();
          const ticket = page.getByRole("dialog", { name: "人工工单" });
          // 1.5 file detail, not schedule mock, owns the expanded ticket. Export has no ID.
          const order =
            replayWithAgentDetails(scenario).hours[14].agent.work_orders[0];
          expect(order.id ?? order.work_order_id).toBeUndefined();
          await expect(ticket.locator("h3")).toHaveText("人工工单 · 暂无数据");
          await expect(ticket.getByRole("alert")).toHaveCount(0);
          for (const check of order.suggested_checks)
            await expect(ticket).toContainText(check);
          await expect(ticket).toContainText("风险评分超过门控阈值");
          await page.keyboard.press("Escape");
        }
        await page
          .getByRole("textbox", { name: "运维问题" })
          .fill("核对当前调度日期？");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        // 25d2f70: no frontend rewriting of backend answer dates or words.
        const raw = replayWithAgentDetails(scenario);
        await expect(page.locator(".agent-answer-text").last()).toHaveText(
          `${raw.hours[14].t} 下发；${raw.hours[15].t} 峰值。`,
        );
        await page.locator(".agent-chat-process summary").last().click();
        await expect(page.locator(".agent-chat-process").last()).toContainText(
          `${display} 14:00`,
        );
        expect(await visibleText(page)).not.toMatch(sourceYears);
        await assertCalendarDisplay(page);
        await info.attach(`${scenario}-visible-text`, {
          body: await visibleText(page),
          contentType: "text/plain",
        });
      }
      expect(
        payloads
          .filter((p) => p.origin)
          .every((p) => p.display_date === "2026-10-12"),
      ).toBe(true);
      // Transport timestamps are NOT presentation dates.
      expect(
        payloads
          .filter((p) => p.start || p.origin)
          .every((p) => (p.start ?? p.origin)!.startsWith("2017-")),
      ).toBe(true);
    });
  });
  });
