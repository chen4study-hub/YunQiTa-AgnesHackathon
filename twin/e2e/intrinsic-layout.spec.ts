import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const replay = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  { width: 1600, height: 830, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1440, height: 600, dpr: 1 },
];
for (const size of sizes) {
  test.describe(`${size.width} DPR ${size.dpr}`, () => {
    test.use({ deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`Agent intrinsic content ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const result = await page.locator(".agent-root").evaluate((root) => {
        const rect = (e: Element) => e.getBoundingClientRect().toJSON();
        const one = (s: string) => rect(root.querySelector(s)!);
        return {
          root: rect(root),
          scroll: root.scrollHeight - root.clientHeight,
          overflow: getComputedStyle(root).overflowY,
          blocks: [
            ...root.querySelectorAll(
              ".agent-decision-card,.agent-record-card,.agent-reason-section,.agent-steps,.agent-comparison,.agent-record-card .agent-table-scroll",
            ),
          ].map((e) => ({
            cls: e.className,
            rect: rect(e),
            overflow: e.scrollHeight - e.clientHeight,
          })),
          plan: one(".agent-reason-section"),
          button: one(".agent-plan-reason > button"),
          comparison: one(".agent-comparison"),
          candidates: [...root.querySelectorAll(".agent-comparison tbody tr")].map(rect),
          fonts: [...root.querySelectorAll(".agent-comparison th,.agent-comparison td,.agent-record-card th,.agent-record-card td")].map(e => parseFloat(getComputedStyle(e).fontSize)),
          actions: one(".agent-actions"),
          steps: one(".agent-steps"),
          last: one(".agent-steps > li:last-child"),
          table: one(".agent-record-card .agent-table-scroll"),
          rows: [],
        };
      });
      await assertShellScrolling(page, `Agent ${size.width} DPR ${size.dpr}`);
      for (const font of result.fonts) expect(font).toBeGreaterThanOrEqual(14);
      const candidateCount = replay.hours[14].agent.candidate_summaries.length;
      expect(candidateCount).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
      for (const b of result.blocks)
        expect(b.overflow, b.cls).toBeLessThanOrEqual(1);
      expect(result.button.bottom).toBeLessThanOrEqual(
        result.plan.bottom + 0.5,
      );
      expect(result.last.bottom).toBeLessThanOrEqual(result.steps.bottom + 0.5);
      expect(result.candidates).toHaveLength(candidateCount);
      for (const row of result.candidates) {
        expect(row.bottom).toBeLessThanOrEqual(result.comparison.bottom + 0.5);
        expect(row.right).toBeLessThanOrEqual(result.comparison.right + 0.5);
      }
      // The wide layout now has explicit decision/record tabs. Measure visible records.
      const tab = page.getByRole("tab", { name: "近期记录（6 小时）", exact: true });
      if (await tab.isVisible()) await tab.click();
      const records = await page.locator(".agent-record-card").evaluate(e => ({
        table: e.querySelector(".agent-table-scroll")!.getBoundingClientRect().toJSON(),
        rows: [...e.querySelectorAll("tbody tr")].map(r => r.getBoundingClientRect().toJSON()),
      }));
      expect(records.rows).toHaveLength(6);
      if (size.dpr === DESKTOP_125.dpr) expect(records.rows[0].height).toBeGreaterThanOrEqual(18);
      for (const row of records.rows)
        expect(row.bottom).toBeLessThanOrEqual(records.table.bottom + 0.5);
      await assertShellScrolling(page, `Agent records ${size.width}`);
      await page
        .locator(".agent-record-card tbody tr:last-child")
        .scrollIntoViewIfNeeded();
      const last = await page
        .locator(".agent-record-card tbody tr:last-child")
        .boundingBox();
      expect(last!.y + last!.height).toBeLessThanOrEqual(
        await page.locator("main").evaluate(e => e.getBoundingClientRect().bottom) + 1,
      );
    });
  });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`forecast intrinsic content ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const result = await page.locator(".forecast-root").evaluate((root) => {
        const rect = (e: Element) => e.getBoundingClientRect().toJSON();
        const region = root.querySelector(".forecast-model-scroll")!;
        return {
          root: rect(root),
          scroll: root.scrollHeight - root.clientHeight,
          overflow: getComputedStyle(root).overflowY,
          cards: [...root.querySelectorAll(".forecast-page > .card")].map(
            (e) => ({
              cls: e.className,
              rect: rect(e),
              overflow: e.scrollHeight - e.clientHeight,
            }),
          ),
          metrics: [...root.querySelectorAll(".forecast-metric")].map((e) => ({
            text: e.textContent,
            value: rect(e.querySelector("dd")!),
            glyph: rect(e.querySelector(".smooth-value")!),
            hint: e.querySelector(":scope > small")
              ? rect(e.querySelector(":scope > small")!)
              : null,
            rect: rect(e),
            overflow: e.scrollHeight - e.clientHeight,
          })),
          model: {
            rect: rect(region),
            overflow: region.scrollHeight - region.clientHeight,
            last: rect(region.querySelector("tbody tr:last-child")!),
          },
        };
      });
      for (const m of result.metrics) {
        if (m.hint) {
          expect(m.hint.top, m.text!).toBeGreaterThanOrEqual(
            m.value.bottom + (size.width >= 1700 ? 5.5 : 1.5),
          );
          expect(m.hint.top, m.text!).toBeGreaterThanOrEqual(m.glyph.bottom);
          expect(m.hint.bottom, m.text!).toBeLessThanOrEqual(m.rect.bottom);
        }
        expect(m.overflow, m.text!).toBeLessThanOrEqual(1);
      }
      expect(result.model.overflow).toBeLessThanOrEqual(1);
      expect(result.model.last.bottom).toBeLessThanOrEqual(
        result.model.rect.bottom + 0.5,
      );
      for (const c of result.cards)
        expect(c.overflow, c.cls).toBeLessThanOrEqual(1);
      await assertShellScrolling(page, `Forecast ${size.width} DPR ${size.dpr}`);
      if (size.dpr === DESKTOP_125.dpr) {
        const plot = await page
          .locator(".forecast-chart-column > .forecast-plot")
          .boundingBox();
        expect(plot!.height).toBeGreaterThanOrEqual(170);
        const row = await page
          .locator(".forecast-model-scroll tbody tr")
          .first()
          .boundingBox();
        expect(row!.height).toBeGreaterThanOrEqual(20);
        // 31851a2: y-axis uses grouped integers, not one-decimal metric labels.
        const labels = await page
          .locator(".forecast-window-plot")
          .evaluate(async (e) => {
            const module = await (
              await fetch("/src/pages/forecast/Plot.tsx")
            ).text();
            const echarts = await import(
              module.match(/from\s+"([^\"]*echarts[^\"]*)"/)![1]
            );
            const instance = echarts.getInstanceByDom(e);
            return instance
              .getZr()
              .storage.getDisplayList()
              .filter((el: any) => /^\d[\d,]*$/.test(el.style?.text ?? ""))
              .map((el: any) => {
                const r = el.getBoundingRect().clone();
                r.applyTransform(el.getComputedTransform());
                return { top: r.y, bottom: r.y + r.height };
              })
              .sort((a: any, b: any) => a.top - b.top);
          });
        expect(labels.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < labels.length; i++)
          expect(labels[i].top - labels[i - 1].bottom).toBeGreaterThanOrEqual(
            2,
          );
      }
      expect(result.overflow).toBe("auto");
      const unit = await page
        .locator(".forecast-floor-plot")
        .evaluate(async (e) => {
          const module = await (
            await fetch("/src/pages/forecast/Plot.tsx")
          ).text();
          const url = module.match(/from\s+"([^\"]*echarts[^\"]*)"/)![1];
          const echarts = await import(url);
          const instance = echarts.getInstanceByDom(e);
          const labels = instance
            .getZr()
            .storage.getDisplayList()
            .filter(
              (el: { style?: { text?: string } }) => el.style?.text === "kW",
            );
          return {
            height: e.clientHeight,
            width: e.clientWidth,
            labels: labels.map((el: any) => {
              const r = el.getBoundingRect().clone();
              r.applyTransform(el.getComputedTransform());
              return {
                top: r.y,
                left: r.x,
                bottom: r.y + r.height,
                right: r.x + r.width,
              };
            }),
          };
        });
      expect(unit.labels).toHaveLength(1);
      for (const label of unit.labels) {
        expect(label.top).toBeGreaterThanOrEqual(2);
        expect(label.left).toBeGreaterThanOrEqual(0);
        expect(label.bottom).toBeLessThanOrEqual(unit.height);
        expect(label.right).toBeLessThanOrEqual(unit.width);
      }
      await page
        .locator(".forecast-model-scroll tbody tr:last-child")
        .scrollIntoViewIfNeeded();
      const mode = await page
        .locator(".forecast-model-scroll tbody tr:last-child")
        .boundingBox();
      expect(mode!.y + mode!.height).toBeLessThanOrEqual(
        await page.locator("main").evaluate(e => e.getBoundingClientRect().bottom) + 1,
      );
    });
  });
  });
}
