import { expect, test } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
import { inspectShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
import { seekPageHour } from "./page-seek";
for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`${viewport.width}: temperature plot >=140px with necessary scrolling`, async ({
    page,
  }) => {
    // Measure the real ECharts Cartesian grid, not just the outer host.
    await page.addInitScript(() => {
      const stroke = CanvasRenderingContext2D.prototype.stroke;
      const move = CanvasRenderingContext2D.prototype.moveTo;
      const line = CanvasRenderingContext2D.prototype.lineTo;
      const paths = new WeakMap<CanvasRenderingContext2D, number[]>();
      const samples: number[] = [];
      (
        window as typeof window & { temperatureGridY: number[] }
      ).temperatureGridY = samples;
      CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
        paths.set(this, [x, y]);
        return move.call(this, x, y);
      };
      CanvasRenderingContext2D.prototype.lineTo = function (x, y) {
        const start = paths.get(this);
        if (start) paths.set(this, [...start.slice(0, 2), x, y]);
        return line.call(this, x, y);
      };
      CanvasRenderingContext2D.prototype.stroke = function (
        ...args: Parameters<typeof stroke>
      ) {
        const path = paths.get(this);
        if (
          this.canvas.closest(".floors-temperature-chart") &&
          this.strokeStyle === "#1c2a36" &&
          path?.length === 4 &&
          Math.abs(path[1] - path[3]) < 1 &&
          Math.abs(path[0] - path[2]) > 100
        ) {
          const transformed = this.getTransform().transformPoint({
            x: path[0],
            y: path[1],
          });
          samples.push(
            transformed.y /
              (this.canvas.width / this.canvas.getBoundingClientRect().width),
          );
        }
        return stroke.apply(this, args);
      };
    });
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-07-23T14:00");
    await seekPageHour(page, 14);
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    const root = page.locator(".floors-page");
    await expect(root.locator(".floors-temperature-chart")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    for (const floor of ["22", "2", "39"]) {
      await page
        .getByRole("combobox", { name: "选择楼层" })
        .selectOption(floor);
      await page.waitForTimeout(450);
      const layout = await root.evaluate((e) => {
        const chart = e.querySelector(".floors-temperature-chart")!;
        const card = chart.closest("section")!;
        return {
          host: chart.getBoundingClientRect().height,
          rootOverflow: e.scrollHeight - e.clientHeight,
          detailOverflow: card.scrollHeight - card.clientHeight,
          chartBottom: chart.getBoundingClientRect().bottom,
          cardBottom: card.getBoundingClientRect().bottom,
          pageOverflow:
            document.querySelector(".page-content")!.scrollHeight -
            document.querySelector(".page-content")!.clientHeight,
        };
      });
      console.log(
        "TEMPERATURE_LAYOUT",
        viewport.width,
        floor,
        JSON.stringify(layout),
      );
      expect(layout.host).toBeGreaterThan(0);
      expect
        .soft(layout.chartBottom)
        .toBeLessThanOrEqual(layout.cardBottom + 1);
      expect
        .soft(
          await page.evaluate(inspectShellScrolling),
          "Ops temperature plot",
        )
        .toEqual([]);
      expect.soft(layout.detailOverflow).toBeLessThanOrEqual(1);
    }
    const gridY = await page.evaluate(
      () =>
        (window as typeof window & { temperatureGridY: number[] })
          .temperatureGridY,
    );
    expect(gridY.length).toBeGreaterThan(2);
    // All repaints have the same frame geometry; includes actual split lines.
    console.log(
      "TEMPERATURE_GRID",
      viewport.width,
      Math.max(...gridY) - Math.min(...gridY),
    );
    expect(Math.max(...gridY) - Math.min(...gridY)).toBeGreaterThanOrEqual(140);
  });
}
