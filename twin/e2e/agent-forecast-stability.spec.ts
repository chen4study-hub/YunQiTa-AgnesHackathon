import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import type { Page } from "@playwright/test";
import { test, expect } from "./v2-test-backend";
import { readFileSync } from "node:fs";
import { currentUI4183 } from "./agent-local-ui-4183";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  await currentUI4183(page);
});

test.use({ reducedMotion: "no-preference" });
const replay = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));

for (const width of [390, 1366, 2560]) {
  test(`chat ${width}: ten long backend answers keep card and left column stable`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 1080 });
    let calls = 0;
    let releaseFirst!: () => void;
    const firstReply = new Promise<void>(resolve => { releaseFirst = resolve; });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        /^\/api/,
        "",
      );
      if (path === "/health")
        return route.fulfill({ json: { llm: { mode: "real" } } });
      if (path === "/chat/stream") return route.fulfill({ status: 404 });
      if (path !== "/chat") return route.abort();
      calls++;
      if (calls === 1) await firstReply;
      const body = route.request().postDataJSON();
      return route.fulfill({
        json: {
          grounded: true,
          origin: body.origin,
          llm_mode: "real",
          answer:
            `后端长回答第${calls}条。` +
            "请按工单核对天气、表计和设备运行记录。".repeat(100),
          tool_trace: [],
        },
      });
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await page
      .getByRole("button", { name: "Agent 决策", exact: false })
      .click();
    await expect(page.locator(".agent-tags")).toContainText("LLM 在线");
    await page.waitForTimeout(400);
    const dimensions = () =>
      page.evaluate(() => {
        const card = document
          .querySelector(".agent-chat-card")!
          .getBoundingClientRect();
        const left = document
          .querySelector(".agent-decision-card")!
          .getBoundingClientRect();
        const records = document
          .querySelector(".agent-record-card")!
          .getBoundingClientRect();
        return {
          height: card.height,
          width: card.width,
          leftWidth: left.width,
          total: document.querySelector(".agent-root")!.getBoundingClientRect()
            .height,
          document: document.documentElement.scrollWidth,
          pageWidth: document.querySelector("main")!.scrollWidth,
        };
      });
    const initial = await dimensions();
    if (width >= 1366)
      expect(Math.abs(initial.height - initial.total)).toBeLessThan(2);
    let saturatedHeight: number | undefined;
    for (let i = 1; i <= 10; i++) {
      await page
        .getByRole("textbox", { name: "运维问题" })
        .fill(`第${i}个长问题`);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      if (i === 1) {
        // HTTP fallback has no tool-process/status row: a single empty reply bubble
        // waits for the held backend response, then receives that answer in place.
        await expect.poll(() => calls).toBe(1);
        await expect(page.locator(".agent-assistant:not(.agent-chat-welcome)")).toHaveCount(1);
        const waiting = page.locator(".agent-assistant").last();
        await expect(waiting).not.toContainText("后端长回答第1条。");
        await waiting.evaluate(el => el.setAttribute("data-test-waiting", "first-reply"));
        releaseFirst();
        await expect(page.locator('[data-test-waiting="first-reply"]')).toContainText("后端长回答第1条。");
      }
      await expect(page.locator(".agent-chat-messages")).toContainText(
        `后端长回答第${i}条。`,
      );
      const now = await dimensions();
      if (width === 390) {
        expect(now.height).toBeGreaterThan(initial.height);
        expect(now.height).toBeLessThan(700);
        saturatedHeight ??= now.height;
        expect(Math.abs(now.height - saturatedHeight)).toBeLessThan(1);
      } else expect(Math.abs(now.height - initial.height)).toBeLessThan(1);
      expect(Math.abs(now.width - initial.width)).toBeLessThan(1);
      expect(Math.abs(now.leftWidth - initial.leftWidth)).toBeLessThan(1);
      expect(now.pageWidth).toBe(initial.pageWidth);
      expect(now.document).toBeLessThanOrEqual(width);
    }
    expect(calls).toBe(10);
    expect(
      await page
        .locator(".agent-chat-messages")
        .evaluate(
          (e) =>
            e.scrollHeight > e.clientHeight &&
            e.scrollHeight - e.scrollTop - e.clientHeight < 3,
        ),
    ).toBe(true);
    const positions = await page.evaluate(() => {
      const card = document
        .querySelector(".agent-chat-card")!
        .getBoundingClientRect();
      const form = document
        .querySelector(".agent-chat-form")!
        .getBoundingClientRect();
      return {
        top: form.top >= card.top - 1,
        bottom: form.bottom <= card.bottom + 1,
        card: { top: card.top, bottom: card.bottom, height: card.height },
        form: { top: form.top, bottom: form.bottom },
      };
    });
    expect(positions.top, JSON.stringify(positions)).toBe(true);
    expect(positions.bottom, JSON.stringify(positions)).toBe(true);
  });
}

for (const width of [390, 1366, 2560]) {
  test(`handoff ${width}: ten seeks keep workflow and records stable`, async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 1080 });
    await api(page);
    await page.goto("/?source=file&scenario=abstain&at=2026-10-12T14:00");
    await page
      .getByRole("button", { name: "Agent 决策", exact: false })
      .click();
    // Hours 8–19 are handoffs in this fixture. Auto→handoff intentionally
    // changes intrinsic content height; measure stability within the same mode.
    await seek(page, 8);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await startMeter(page);
    const charts = await page
      .locator(".agent-root .forecast-plot")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("_echarts_instance_")),
      );
    for (let hour = 9; hour < 19; hour++) {
      await seek(page, hour);
      await expect(page.locator(".agent-status-bar")).toContainText("转交人工");
      await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(6);
    }
    const shifts = await page.evaluate(
      () =>
        (
          window as typeof window & {
            shifts: { value: number; nodes: string[] }[];
          }
        ).shifts,
    );
    // User-triggered changes in a mobile reason preview are not unexpected CLS.
    const total = shifts
      .filter((s) => !(s as { recent?: boolean }).recent)
      .reduce((sum, s) => sum + s.value, 0);
    console.log(`handoff ${width}: cumulative shifts=${total}`);
    expect(total, JSON.stringify(shifts)).toBeLessThan(0.01);
    expect(
      await page
        .locator(".agent-root .forecast-plot")
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("_echarts_instance_")),
        ),
    ).toEqual(charts);
    await expect(
      page.getByRole("button", { name: "指派给值班工程师", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "指派给值班工程师", exact: true })
      .click();
    await expect(
      page.locator(".agent-record-card tbody tr").first(),
    ).toContainText("已指派");
    await info.attach("handoff", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

async function api(page: Page, available = false, scheduleDelay = 0) {
  await page.route("**/api/**", async (route) => {
    if (!available) return route.abort();
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/health")
      return route.fulfill({ json: { llm: { mode: "rule" } } });
    if (path === "/chat/stream") return route.fulfill({ status: 404 });
    if (path === "/chat") {
      const body = route.request().postDataJSON();
      return route.fulfill({
        json: {
          grounded: true,
          origin: body.origin,
          llm_mode: "real",
          answer: "后端工具答复：采用已校验的方案。",
          tool_trace: [{ tool: "get_forecast" }],
        },
      });
    }
    // /takeover and history GETs have no JSON body; only /schedule carries start.
    if (path !== "/schedule") return route.abort();
    if (scheduleDelay) await new Promise((r) => setTimeout(r, scheduleDelay));
    const body = route.request().postDataJSON();
    const h = replay.hours.find((h: { t: string }) => h.t === body.start);
    if (!h)
      throw new Error(
        "e2e fixture must use current file replay, not adapter fallback",
      );
    const command = {
      timestamp: h.t,
      hvac_setpoint_c: 25.5,
      battery_kw: 0,
      prepared_upper_kw: h.upper_kw,
      action: h.abstain ? "human_review" : "hold",
    };
    return route.fulfill({
      json: {
        building_id: replay.meta.building_id,
        plan: [command],
        candidates: [
          {
            candidate_id: "rule_full",
            plan: [command],
            simulation: { estimated_cost: 321.4, estimated_peak_kw: 456.7 },
          },
          {
            candidate_id: "rule_conservative",
            plan: [command],
            simulation: { estimated_cost: 543.2, estimated_peak_kw: 678.9 },
          },
        ],
        selected: "rule_conservative",
        reason: "后端原文：选中保守方案。",
        explanation: "不能替换 reason",
        work_orders: [],
        needs_human: h.abstain,
        receipt: {
          count: h.abstain ? 0 : 2,
          elapsed_ms: 1.234,
          transport: "log_only",
          device_connected: false,
        },
      },
    });
  });
}
async function seek(page: Page, hour: number) {
  const slider = page.getByRole("slider", { name: "24 小时时间轴" });
  const current = Number(await slider.getAttribute("aria-valuenow"));
  if (Math.abs(hour - current) <= 1)
    await slider.press(hour > current ? "ArrowRight" : "ArrowLeft");
  else {
    await slider.press("Home");
    for (let i = 0; i < Math.floor(hour / 6); i++) await slider.press("PageUp");
    for (let i = 0; i < hour % 6; i++) await slider.press("ArrowRight");
  }
  await expect(page.locator(".timeline")).toHaveAttribute(
    "data-time",
    String(hour),
  );
  await page.waitForTimeout(420);
}
async function startMeter(page: Page) {
  await page.evaluate(() => {
    const w = window as typeof window & {
      shifts: { value: number; recent: boolean; nodes: unknown[] }[];
    };
    w.shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources: { node?: Element }[];
        };
        w.shifts.push({
          value: shift.value,
          recent: shift.hadRecentInput,
          nodes: shift.sources.map((s) => ({
            class: s.node?.className || s.node?.tagName || "",
            text: s.node?.textContent?.slice(0, 100),
            previous: (s as typeof s & { previousRect: DOMRectReadOnly })
              .previousRect,
            current: (s as typeof s & { currentRect: DOMRectReadOnly })
              .currentRect,
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
}
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
]) {
  for (const tab of ["Agent 决策", "预测与风险"]) {
    test(`${tab} ${viewport.width}: ten seeks preserve chart instances and near-zero CLS`, async ({
      page,
    }, info) => {
      test.setTimeout(60000);
      await page.setViewportSize(viewport);
      await api(page);
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: tab, exact: false }).click();
      await expect(page.locator(".clock")).toContainText("14:00");
      const root = page.locator(
        tab === "Agent 决策" ? ".agent-root" : ".forecast-root",
      );
      await expect(root).toBeVisible();
      await seek(page, 4);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const instances = await root
        .locator(
          ".forecast-window-plot, .forecast-confidence-plot, .forecast-floor-plot",
        )
        .evaluateAll((nodes) =>
          nodes.map((e) => e.getAttribute("_echarts_instance_")),
        );
      const phoneAgent = tab === "Agent 决策" && viewport.width === 390;
      if (phoneAgent) {
        const rows = await page.locator(".agent-plan li").evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
          }),
        );
        expect(Math.abs(rows[0].y - rows[1].y)).toBeLessThanOrEqual(1);
        expect(rows[1].x).toBeGreaterThan(rows[0].x + rows[0].width);
        expect(rows[2].y).toBeGreaterThanOrEqual(rows[0].bottom);
        expect(Math.abs(rows[2].x - rows[0].x)).toBeLessThanOrEqual(1);
        expect(rows[2].width).toBeGreaterThan(rows[0].width + rows[1].width);
      }
      await startMeter(page);
      if (phoneAgent)
        await page.evaluate(() => {
          type Box = {
            class: string;
            x: number;
            y: number;
            width: number;
            height: number;
          };
          const w = window as typeof window & {
            agentMotion: {
              frame: number;
              moving: { previous: Box; current: Box }[];
            };
          };
          w.agentMotion = { frame: 0, moving: [] };
          const original = new Map<Element, Box>();
          const sample = () => {
            for (const e of document.querySelectorAll(
              ".agent-plan, .agent-plan-number, .agent-plan-number small, .agent-evidence-row",
            )) {
              const r = e.getBoundingClientRect();
              const box = {
                class: e.className,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
              };
              const previous = original.get(e);
              // Units follow changing digits horizontally; their line/height must
              // stay fixed. Evidence content can vary, but its origin cannot jump.
              const axes: (keyof Omit<Box, "class">)[] = e.matches(
                ".agent-plan-number small",
              )
                ? ["y", "height"]
                : e.classList.contains("agent-evidence-row")
                  ? ["x", "y"]
                  : ["x", "y", "width", "height"];
              if (!previous) original.set(e, box);
              else if (axes.some((k) => Math.abs(previous[k] - box[k]) > 1))
                w.agentMotion.moving.push({ previous, current: box });
            }
            w.agentMotion.frame = requestAnimationFrame(sample);
          };
          sample();
        });
      for (let hour = 5; hour < 15; hour++) {
        await seek(page, hour);
        if (tab === "Agent 决策")
          await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(
            6,
          );
        if (phoneAgent) {
          const metrics = await page
            .locator(".agent-plan-number")
            .evaluateAll((els) =>
              els.map((e) => {
                const value = e
                  .querySelector(".smooth-value > span")!
                  .getBoundingClientRect();
                const unit = e.querySelector("small")!.getBoundingClientRect();
                const label = e
                  .parentElement!.querySelector(".agent-plan-label")!
                  .getBoundingClientRect();
                return {
                  leftAligned: Math.abs(value.left - label.left) <= 1,
                  overflow: e.scrollWidth - e.clientWidth,
                  sameLine:
                    Math.min(value.bottom, unit.bottom) >
                    Math.max(value.top, unit.top),
                  adjacent:
                    unit.left >= value.right - 1 &&
                    unit.left <= value.right + 5,
                  nowrap:
                    getComputedStyle(e).whiteSpace === "nowrap" &&
                    getComputedStyle(e.querySelector("small")!).whiteSpace ===
                      "nowrap",
                };
              }),
            );
          expect(metrics).toEqual(
            Array.from({ length: 3 }, () => ({
              leftAligned: true,
              overflow: 0,
              sameLine: true,
              adjacent: true,
              nowrap: true,
            })),
          );
        }
      }
      const shifts = await page.evaluate(
        () =>
          (
            window as typeof window & {
              shifts: { value: number; recent: boolean; nodes: unknown[] }[];
            }
          ).shifts,
      );
      const total = shifts.reduce((sum, s) => sum + s.value, 0);
      const cls = shifts
        .filter((s) => !s.recent)
        .reduce((sum, s) => sum + s.value, 0);
      if (phoneAgent) {
        const moving = await page.evaluate(() => {
          const w = window as typeof window & {
            agentMotion: { frame: number; moving: unknown[] };
          };
          cancelAnimationFrame(w.agentMotion.frame);
          return w.agentMotion.moving;
        });
        await info.attach("moving-elements", {
          body: JSON.stringify(moving),
          contentType: "application/json",
        });
        expect(moving).toEqual([]);
      }
      await info.attach("layout-shifts", {
        body: JSON.stringify({ total, cls, shifts }),
        contentType: "application/json",
      });
      console.log(
        `${tab} ${viewport.width}: raw layout shifts=${total}, CLS=${cls}`,
      );
      expect(total, JSON.stringify(shifts)).toBeLessThan(0.01);
      expect(cls).toBeLessThan(0.01);
      expect(
        await root
          .locator(
            ".forecast-window-plot, .forecast-confidence-plot, .forecast-floor-plot",
          )
          .evaluateAll((nodes) =>
            nodes.map((e) => e.getAttribute("_echarts_instance_")),
          ),
      ).toEqual(instances);
      if (tab === "预测与风险") expect(instances.every(Boolean)).toBe(true);
      expect(await root.innerText()).not.toMatch(
        /历史回放|估算|模拟|本地|固定规则计算/,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const boxes = await root
        .locator(
          ".agent-page > .card, .agent-page > .agent-chat-slot, .forecast-page > .card",
        )
        .evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              clipped:
                e.scrollHeight > e.clientHeight + 2 &&
                ["auto", "hidden", "clip"].includes(
                  getComputedStyle(e).overflowY,
                ),
            };
          }),
        );
      expect(boxes.every((b) => !b.clipped)).toBe(true);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i],
            b = boxes[j];
          expect(
            Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1,
          ).toBe(false);
        }
      const screenshot = info.outputPath("layout.png");
      await page.screenshot({ path: screenshot });
      await info.attach("page-layout", {
        path: screenshot,
        contentType: "image/png",
      });
      if (tab === "Agent 决策") {
        const recordTab = page
          .getByRole("tab", { name: "近期记录（6 小时）" })
          .first();
        if (await recordTab.isVisible()) await recordTab.click();
        await page
          .locator(".agent-record-card tbody tr")
          .last()
          .scrollIntoViewIfNeeded();
        await expect(
          page.locator(".agent-record-card tbody tr").last(),
        ).toBeInViewport();
        const decisionTab = page
          .getByRole("tab", { name: "当前决策", exact: true })
          .first();
        if (await decisionTab.isVisible()) await decisionTab.click();
        await page.locator(".agent-reason-section").scrollIntoViewIfNeeded();
        await expect(page.locator(".agent-reason-preview")).toBeInViewport({
          ratio: 1,
        });
        const candidates = page.getByRole("region", { name: "候选方案表" });
        await candidates.scrollIntoViewIfNeeded();
        await expect(candidates).toBeInViewport();
      }
    });
  }
}

test("backend reason/two candidates are authoritative; badge follows health and midnight keeps six honest records", async ({
  page,
}) => {
  await api(page, true, 2200);
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "Agent 决策", exact: false }).click();
  await expect(page.locator(".agent-root")).toHaveAttribute(
    "data-decision-source",
    "replay",
  );
  await page.waitForTimeout(300);
  await startMeter(page);
  await expect(page.locator(".agent-root")).toHaveAttribute(
    "data-decision-source",
    "schedule",
  );
  const total = await page.evaluate(() =>
    (window as typeof window & { shifts: { value: number }[] }).shifts.reduce(
      (s, e) => s + e.value,
      0,
    ),
  );
  console.log(`delayed schedule: shifts=${total}`);
  expect(total).toBeLessThan(0.01);
  await expect(page.locator(".agent-reason-preview")).toHaveText(
    "后端原文：选中保守方案。",
  );
  await expect(
    page.getByRole("region", { name: "候选方案表" }).locator("tbody tr"),
  ).toHaveCount(2);
  await expect(page.getByRole("region", { name: "候选方案表" })).toContainText(
    "456.7",
  );
  await expect(page.getByRole("region", { name: "候选方案表" })).toContainText(
    "543.2",
  );
  await page
    .getByRole("button", { name: "为什么这样调度？", exact: true })
    .click();
  await expect(page.locator(".agent-chat-messages")).toContainText(
    "后端工具答复",
  );
  // Health fixture says rule; current badge follows health, not chat provenance.
  await expect(page.locator(".agent-tags")).toContainText("未接 LLM");
  await seek(page, 0);
  await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(6);
  await expect(
    page
      .locator(".agent-record-card tbody tr")
      .filter({ hasText: "该时段记录未提供" }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-record-card tbody")).toContainText(
    "昨日 23:00",
  );
});
