import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
const charts = [
  ["楼层与电梯", ".floors-load-chart"],
  ["楼层与电梯", ".floors-temperature-chart"],
  ["能源与告警", ".energy-donut-chart"],
  ["能源与告警", ".energy-ems .energy-timeseries"],
  ["能源与告警", ".energy-environment .energy-timeseries"],
];
for (const width of [1366, DESKTOP_125.width, 1920, 2560, 390])
  for (const [label, selector] of charts)
    test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`canvas tooltip ${width} ${selector}`, async ({ page }, testInfo) => {
      test.setTimeout(90000);
      await page.setViewportSize({
        width,
        height:
          width === 390
            ? 844
            : width === 1366
              ? 768
              : width === DESKTOP_125.width
                ? DESKTOP_125.height
                : 1080,
      });
      await page.addInitScript(() => {
        const original = CanvasRenderingContext2D.prototype.fillText;
        (window as any).tooltipSamples = [];
        CanvasRenderingContext2D.prototype.fillText = function (
          ...args: Parameters<typeof original>
        ) {
          const host = this.canvas.closest("[data-chart-id]");
          if (host?.matches((window as any).captureChart ?? "invalid")) {
            const samples = (window as any).tooltipSamples as string[];
            if (samples.length < 3000) samples.push(String(args[0]));
          }
          return original.apply(this, args);
        };
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-13T01:47");
      await expect(page.locator(".bottombar")).toBeVisible();
      await page.getByRole("button", { name: label }).click();
      const host = page.locator(selector);
      await expect(host).toBeVisible();
      await host.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const source = await (
          await page.request.get("/src/pages/energy/SmoothChart.tsx")
        ).text(),
        moduleUrl = source.match(/from ["']([^"']*echarts\.js[^"']*)["']/)![1];
      // Hover actual hourly samples: the 24:00 axis boundary is not a data row.
      // Pie radius is relative to min(width, height), not height alone.
      const timed =
        selector.includes("temperature") || selector.includes("timeseries");
      for (const hour of timed
        ? selector.includes("temperature")
          ? [18]
          : [0, 18, 23]
        : [0]) {
        const coord = await host.evaluate(
          async (el, { moduleUrl, hour }) => {
            const ec = await import(/* @vite-ignore */ moduleUrl),
              chart = ec.getInstanceByDom(el),
              o = chart.getOption();
            if (o.series[0].type === "pie")
              return [el.clientWidth / 2, el.clientHeight / 2 - Math.min(el.clientWidth, el.clientHeight) * 0.38];
            if (o.yAxis[0].type === "category") {
              const index = 21,
                v = o.series[0].data[index].value;
              return chart.convertToPixel({ seriesIndex: 0 }, [v * 0.7, index]);
            }
            const min = o.yAxis[0].min,
              max = o.yAxis[0].max;
            return chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [
              hour === 0 ? 0.2 : hour,
              (min + max) / 2,
            ]);
          },
          { moduleUrl, hour },
        );
        expect(coord.every(Number.isFinite)).toBe(true);
        await page.mouse.move(1, 1);
        await page.waitForTimeout(100);
        await page.evaluate((selector) => {
          (window as any).captureChart = selector;
          (window as any).tooltipSamples = [];
        }, selector);
        const box = await host.boundingBox();
        await page.mouse.move(box!.x + coord[0], box!.y + coord[1], {
          steps: 2,
        });
        await expect
          .poll(async () =>
            page.evaluate(() => (window as any).tooltipSamples.length),
          )
          .toBeGreaterThan(0);
        await page.waitForTimeout(350);
        const texts = await page.evaluate(
          () => (window as any).tooltipSamples as string[],
        );
        console.log(width, selector, hour, JSON.stringify([...new Set(texts)]));
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
          expect(text).not.toMatch(/\d+\.\d{2,}/);
          expect(text).not.toMatch(/^\d+\.\d{2}$/);
          expect(text).not.toMatch(/\d\s+%/);
        }
        const readings = texts.flatMap((text) => [
          ...text.matchAll(/  (-?[\d,]+(?:\.\d+)?) (kW|℃|人|ppm)/g),
        ]);
        expect(readings.length).toBeGreaterThan(0);
        for (const [, value, unit] of readings)
          expect(value).toMatch(
            unit === "kW" || unit === "℃" ? /^-?[\d,]+\.\d$/ : /^-?[\d,]+$/,
          );
        // One hover image per chart and viewport for visual review.
        if (hour === (timed ? 18 : 0)) {
          const image = await host.evaluate(async (el, moduleUrl) => {
            const ec = await import(/* @vite-ignore */ moduleUrl);
            return ec.getInstanceByDom(el).getDataURL({ pixelRatio: 1 });
          }, moduleUrl);
          writeFileSync(
            testInfo.outputPath("tooltip.png"),
            Buffer.from(image.split(",")[1], "base64"),
          );
        }
        if (timed)
          expect(texts).toContain(
            `${String(hour).padStart(2, "0")}:00`,
          );
      }
    });
  });
