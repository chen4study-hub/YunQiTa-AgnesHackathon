import { expect, test } from "@playwright/test";
import { realReplayFixture } from "./real-replay-fixture";

for (const [width, height] of [
  [390, 844],
  [1366, 768],
  [1920, 1080],
]) {
  test(`overview chart has readable, separated labels and a usable plot at ${width}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await realReplayFixture(page);
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T09:00");
    // Let Vite dependency-discovery reloads settle before probing the canvas.
    await page.waitForLoadState("networkidle");
    const host = page.locator(".replay-chart .echart");
    await expect(host).toHaveAttribute("_echarts_instance_", /./, {
      timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const result = await host.evaluate(async (el) => {
      const source = await (await fetch("/src/components/EChart.tsx")).text();
      const url = source.match(
        /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
      )![1];
      const ec = await import(/* @vite-ignore */ url);
      const chart = ec.getInstanceByDom(el);
      const model = chart.getModel();
      const plot = model.getComponent("grid").coordinateSystem.getRect();
      const labels = chart
        .getZr()
        .storage.getDisplayList()
        .filter(
          (item: any) =>
            item.type === "tspan" &&
            !item.invisible &&
            !item.ignore &&
            /^(?:实测|预测|(?:(?:昨日|次日) )?\d{2}:\d{2}|[\d,]+)$/.test(
              String(item.style.text),
            ),
        )
        .map((item: any) => {
          const box = item.getBoundingRect().clone();
          box.applyTransform(item.getComputedTransform());
          return {
            text: String(item.style.text),
            font: item.style.font,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          };
        });
      return {
        labels,
        width: el.clientWidth,
        height: el.clientHeight,
        plot: { x: plot.x, y: plot.y, width: plot.width, height: plot.height },
        tooltipFont: model.getComponent("tooltip").get("textStyle.fontSize"),
      };
    });
    expect(result.labels.length).toBeGreaterThanOrEqual(6);
    expect(result.labels.map((label: any) => label.text)).toEqual(
      expect.arrayContaining(["实测", "预测", "次日 09:00"]),
    );
    expect(result.tooltipFont).toBe(13);
    expect(result.plot.height).toBeGreaterThan(result.height * 0.5);
    expect(result.plot.width).toBeGreaterThan(result.width * 0.5);
    for (const label of result.labels) {
      expect(
        Number(label.font.match(/([\d.]+)px/)[1]),
        label.text,
      ).toBeGreaterThanOrEqual(12);
      expect(label.x, label.text).toBeGreaterThanOrEqual(-0.5);
      expect(label.x + label.width, label.text).toBeLessThanOrEqual(
        result.width + 0.5,
      );
      expect(label.y, label.text).toBeGreaterThanOrEqual(-0.5);
      expect(label.y + label.height, label.text).toBeLessThanOrEqual(
        result.height + 0.5,
      );
    }
    for (let i = 0; i < result.labels.length; i++)
      for (let j = i + 1; j < result.labels.length; j++) {
        const a = result.labels[i],
          b = result.labels[j];
        const overlapX =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX > 0.5 && overlapY > 0.5, `${a.text} / ${b.text}`).toBe(
          false,
        );
      }
    await page
      .locator(".replay-chart")
      .screenshot({ path: testInfo.outputPath("overview-chart.png") });
    console.log("OVERVIEW_CHART", width, JSON.stringify(result.plot));
  });
}
