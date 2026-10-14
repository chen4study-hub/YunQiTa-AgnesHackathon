import { seekPageHour } from "./page-seek";
import { test, expect } from "@playwright/test";

type ShiftSource = {
  node: Node | null;
  previousRect: DOMRectReadOnly;
  currentRect: DOMRectReadOnly;
};
type ShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources?: ShiftSource[];
};
type Diagnostics = {
  cls: number;
  total: number;
  pageTotal: number;
  mutations: number;
  sources: {
    element: string;
    value: number;
    dx: number;
    dy: number;
    widthChange: number;
    page: boolean;
  }[];
};

for (const scenario of ["normal", "peak", "abstain"])
  for (const name of ["楼层与电梯", "能源与告警"])
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
    ]) {
      test(`${name} ${viewport.width}px ${scenario}: ten times keep page CLS near zero and charts mounted`, async ({
        page,
      }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize(viewport);
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
        );
        await page.getByRole("button", { name }).click();
        const root = page.locator(
          name === "楼层与电梯" ? ".floors-page" : ".energy-page",
        );
        await expect(root.locator("[data-chart-id]").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(600);
        const ids = await root
          .locator("[data-chart-id]")
          .evaluateAll((es) => es.map((e) => e.getAttribute("data-chart-id")));
        await root.evaluate((element) => {
          const diagnostics: Diagnostics = {
            cls: 0,
            total: 0,
            pageTotal: 0,
            mutations: 0,
            sources: [],
          };
          (
            window as typeof window & { transitionMetrics: Diagnostics }
          ).transitionMetrics = diagnostics;
          new PerformanceObserver((list) => {
            for (const raw of list.getEntries()) {
              const entry = raw as ShiftEntry;
              const sources = entry.sources ?? [];
              if (sources.some((s) => s.node && element.contains(s.node)))
                diagnostics.pageTotal += entry.value;
              diagnostics.total += entry.value;
              if (!entry.hadRecentInput) diagnostics.cls += entry.value;
              for (const source of sources) {
                const node =
                  source.node?.nodeType === Node.TEXT_NODE
                    ? source.node.parentElement
                    : source.node;
                diagnostics.sources.push({
                  element:
                    node instanceof Element
                      ? `${node.tagName.toLowerCase()}.${node.className}`
                      : "unknown",
                  value: entry.value,
                  dx: source.currentRect.x - source.previousRect.x,
                  dy: source.currentRect.y - source.previousRect.y,
                  widthChange:
                    source.currentRect.width - source.previousRect.width,
                  page: !!source.node && element.contains(source.node),
                });
              }
            }
          }).observe({ type: "layout-shift" });
          new MutationObserver((records) => {
            for (const record of records)
              for (const node of [...record.addedNodes, ...record.removedNodes])
                if (
                  node instanceof Element &&
                  (node.matches("canvas,[data-chart-id]") ||
                    node.querySelector("canvas,[data-chart-id]"))
                )
                  diagnostics.mutations++;
          }).observe(element, { childList: true, subtree: true });
        });
        for (const hour of [2, 17, 8, 21, 12, 4, 19, 6, 15, 10]) {
          await seekPageHour(page, hour);
          await expect(root).toHaveAttribute("data-time", String(hour));
          await page.waitForTimeout(420);
        }
        expect(
          await root
            .locator("[data-chart-id]")
            .evaluateAll((es) =>
              es.map((e) => e.getAttribute("data-chart-id")),
            ),
        ).toEqual(ids);
        const metrics = await page.evaluate(
          () =>
            (window as typeof window & { transitionMetrics: Diagnostics })
              .transitionMetrics,
        );
        await testInfo.attach("transition-metrics", {
          body: JSON.stringify(metrics, null, 2),
          contentType: "application/json",
        });
        expect(metrics.mutations).toBe(0);
        // Page-owned sources only, including recent input. Whole-window CLS is recorded,
        // not asserted: shared timeline/date shifts are managed by the shell owner.
        expect(metrics.pageTotal).toBeLessThan(0.005);
      });
    }
