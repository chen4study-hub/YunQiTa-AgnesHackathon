import { test, expect } from "@playwright/test";
import { realReplayFixture } from "./real-replay-fixture";

test.use({
  viewport: { width: 1920, height: 1080 },
  reducedMotion: "no-preference",
});
test("overview chart reuses dimensions on return and catches up changed hidden data", async ({
  page,
}) => {
  await realReplayFixture(page);
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&at=2026-10-12T11:25");
  const host = page.locator(".replay-chart .echart");
  await expect(host.locator("canvas")).toBeVisible();
  await page.waitForTimeout(1500);
  const source = await (
    await page.request.get("/src/components/EChart.tsx")
  ).text();
  const moduleUrl = source.match(/from ["']([^"']*echarts\.js[^"']*)["']/)![1];
  await host.evaluate(async (el, url) => {
    const ec = await import(/* @vite-ignore */ url),
      chart = ec.getInstanceByDom(el);
    const stats = { resize: 0, update: 0 };
    (window as any).__retainedChart = { chart, stats };
    const resize = chart.resize.bind(chart),
      setOption = chart.setOption.bind(chart);
    chart.resize = (...args: unknown[]) => {
      stats.resize++;
      return resize(...args);
    };
    chart.setOption = (...args: unknown[]) => {
      stats.update++;
      return setOption(...args);
    };
  }, moduleUrl);
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator("main")).toHaveAttribute("data-page", "about");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "总览", exact: false }).click();
  await expect(page.locator("main")).toHaveAttribute("data-page", "overview");
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as any).__retainedChart.stats),
  ).toEqual({ resize: 0, update: 0 });

  const before = await host.evaluate(async (el, url) => {
    const ec = await import(/* @vite-ignore */ url);
    return JSON.stringify(
      ec
        .getInstanceByDom(el)
        .getOption()
        .series.map((s: any) => s.data),
    );
  }, moduleUrl);
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator("main")).toHaveAttribute("data-page", "about");
  await page.getByRole("slider", { name: "24 小时时间轴" }).press("ArrowRight");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "总览", exact: false }).click();
  await expect(page.locator("main")).toHaveAttribute("data-page", "overview");
  await expect
    .poll(async () =>
      host.evaluate(async (el, url) => {
        const ec = await import(/* @vite-ignore */ url);
        return JSON.stringify(
          ec
            .getInstanceByDom(el)
            .getOption()
            .series.map((s: any) => s.data),
        );
      }, moduleUrl),
    )
    .not.toBe(before);
  expect(
    await page.evaluate(() => (window as any).__retainedChart.stats.resize),
  ).toBe(0);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__retainedChart.stats.resize),
    )
    .toBeGreaterThan(0);
});
