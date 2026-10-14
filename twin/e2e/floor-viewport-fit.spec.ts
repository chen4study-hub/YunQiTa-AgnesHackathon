import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  DESKTOP_125, // physical 1600×830 at 125%
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
]) {
  test.describe(`floor layout DPR ${viewport.dpr ?? 1} / ${viewport.width}`, () => {
    test.use({ deviceScaleFactor: viewport.dpr ?? 1 });
    test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test(`floor viewport fit and zero false scrollbars ${viewport.width}`, async ({
      page,
    }, info) => {
      test.setTimeout(60000);
      await isolateOpsTest(page);
      await page.setViewportSize(viewport);
      await page.goto("/?source=file&at=2026-10-12T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: "楼层与电梯" }).click();
      const root = page.locator(".floors-page");
      await expect(root).toHaveAttribute("data-time", "14");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const moduleSource = await (
        await page.request.get("/src/pages/energy/SmoothChart.tsx")
      ).text();
      const moduleUrl = moduleSource.match(
        /from ["']([^"']*echarts\.js[^"']*)["']/,
      )![1];
      for (const floor of [22, 2, 39]) {
        await page
          .getByRole("combobox", { name: "选择楼层" })
          .selectOption(String(floor));
        await page.waitForTimeout(450);
        await assertShellScrolling(page, `floors ${viewport.width}/${floor}`);
        const scales = await root
          .locator(".floors-temperature-display")
          .evaluateAll((es) =>
            es.map((e) => {
              const line = e
                .querySelector(".floors-temperature-limit")!
                .getBoundingClientRect();
              const scale = e
                .querySelector(".floors-temperature-scale")!
                .getBoundingClientRect();
              const labels = Array.from(
                e.querySelectorAll(".floors-temperature-scale span"),
              ).map((e) => e.getBoundingClientRect());
              return {
                difference: Math.abs(
                  labels[1].left + labels[1].width / 2 - line.left,
                ),
                endpoints:
                  labels[0].left >= scale.left - 1 &&
                  labels[2].right <= scale.right + 1,
              };
            }),
          );
        for (const s of scales) {
          expect(s.difference).toBeLessThanOrEqual(1);
          expect(s.endpoints).toBe(true);
        }
        const settings = await root
          .locator(".floors-zone-setting")
          .evaluateAll((es) =>
            es.map((e) => {
              const spans = Array.from(e.children).map((s) =>
                s.getBoundingClientRect(),
              );
              return {
                count: spans.length,
                wrapped: Array.from(e.children).some((s) => {
                  const r = document.createRange();
                  r.selectNodeContents(s);
                  return (
                    new Set(
                      Array.from(r.getClientRects())
                        .filter((r) => r.width > 0)
                        .map((r) => Math.round(r.top)),
                    ).size !== 1
                  );
                }),
                fits: spans.every(
                  (r) =>
                    r.left >= e.getBoundingClientRect().left - 1 &&
                    r.right <= e.getBoundingClientRect().right + 1,
                ),
                top: spans[0]?.bottom,
                bottom: spans[1]?.top,
              };
            }),
          );
        for (const s of settings) {
          expect(s.count).toBe(2);
          expect(s.wrapped).toBe(false);
          expect(s.fits).toBe(true);
          expect(s.top).toBeLessThanOrEqual(s.bottom);
        }
        const geometry = await root.evaluate(async (root, moduleUrl) => {
          const ec = await import(/* @vite-ignore */ moduleUrl);
          const temperature = root.querySelector<HTMLElement>(
            ".floors-temperature-chart",
          )!;
          const chart = ec.getInstanceByDom(temperature);
          const grid = chart
            .getModel()
            .getComponent("grid")
            .coordinateSystem.getRect();
          const main = document.querySelector("main")!;
          const load = root.querySelector<HTMLElement>(".floors-load-chart")!;
          return {
            detail: Array.from(
              root.querySelectorAll(".floors-detail-card > *"),
            ).map((e) => ({
              cls: e.className,
              height: e.getBoundingClientRect().height,
            })),
            detailExcess:
              root.querySelector(".floors-detail-card")!.scrollHeight -
              root.querySelector(".floors-detail-card")!.clientHeight,
            rootOverflow: root.scrollHeight - root.clientHeight,
            mainOverflow: main.scrollHeight - main.clientHeight,
            plotHeight: grid.height,
            chartHeight: temperature.clientHeight,
            loadHeight: load.clientHeight,
            labelStride: Number(load.dataset.labelStride),
            clipped: Array.from(
              root.querySelectorAll<HTMLElement>(
                "section,.floors-zone,.floors-metrics",
              ),
            )
              .filter(
                (e) =>
                  e.scrollHeight - e.clientHeight > 3 ||
                  e.scrollWidth - e.clientWidth > 1,
              )
              .map((e) => e.className),
            high: Array.from(root.querySelectorAll(".floors-high")).map(
              (e) => e.getBoundingClientRect().bottom,
            ),
            mainBottom: main.getBoundingClientRect().bottom,
          };
        }, moduleUrl);
        console.log(viewport.width, floor, JSON.stringify(geometry));
        expect(geometry.clipped).toEqual([]);
        expect(geometry.mainOverflow).toBeLessThanOrEqual(1);
        expect(geometry.plotHeight).toBeGreaterThanOrEqual(140);
        if (viewport.width >= 1366) {
          expect(geometry.rootOverflow).toBeLessThanOrEqual(
            viewport.width === 1920 ? 0 : 60,
          );
          expect(geometry.labelStride).toBeLessThanOrEqual(2);
          for (const bottom of geometry.high)
            expect(bottom).toBeLessThanOrEqual(geometry.mainBottom + 1);
        }
      }
      await root.locator(".floors-metrics-card").scrollIntoViewIfNeeded();
      for (const metric of await root.locator(".floors-metrics > div").all())
        await expect(metric).toBeInViewport({ ratio: 1 });
      await assertShellScrolling(
        page,
        `floors metrics accessible ${viewport.width}`,
      );
      await root.evaluate((e) => {
        e.scrollTop = 0;
      });
      await page.screenshot({
        path: info.outputPath(`floors-${viewport.width}.png`),
      });
    });
  });
  });
}
