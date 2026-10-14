import { expect, test } from "@playwright/test";
import { DESKTOP_125, RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";

for (const size of [
  DESKTOP_125,
  { width: 1366, height: 768, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`energy drawable area ${size.width} DPR ${size.dpr}`, () => {
    test.use({ deviceScaleFactor: size.dpr });
    test("both real Cartesian grids reserve 140px and main owns useful scrolling", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await isolateOpsTest(page);
      await page.setViewportSize(size);
      await page.goto("/?source=file&at=2026-10-12T14:00", {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: "能源与告警" }).click();
      await expect(page.locator(".energy-timeseries")).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
      const source = await (
        await page.request.get("/src/pages/energy/SmoothChart.tsx")
      ).text();
      const moduleUrl = source.match(
        /from ["']([^"']*echarts\.js[^"']*)["']/,
      )![1];
      const geometry = await page
        .locator(".energy-page")
        .evaluate(async (root, url) => {
          const ec = await import(/* @vite-ignore */ url),
            main = root.closest("main")!;
          const charts = Array.from(
            root.querySelectorAll<HTMLElement>(".energy-timeseries"),
          ).map((host) => {
            const chart = ec.getInstanceByDom(host),
              model = chart.getModel();
            const rect = model.getComponent("grid").coordinateSystem.getRect();
            return {
              name: host.getAttribute("aria-label"),
              hostHeight: host.clientHeight,
              drawableHeight: rect.height,
              top: rect.y,
              bottom: host.clientHeight - rect.y - rect.height,
              fonts: chart
                .getOption()
                .yAxis.map((axis: any) => axis.axisLabel.fontSize),
            };
          });
          return {
            charts,
            mainOverflow: main.scrollHeight - main.clientHeight,
            mainScrolling: getComputedStyle(main).overflowY,
            pageOverflow: root.scrollHeight - root.clientHeight,
            pageScrolling: getComputedStyle(root).overflowY,
            horizontal: main.scrollWidth - main.clientWidth,
            clipped: Array.from(
              root.querySelectorAll<HTMLElement>(
                ".energy-ems, .energy-environment, .energy-chart-slot",
              ),
            )
              .filter((e) => e.scrollHeight - e.clientHeight > 1)
              .map((e) => e.className),
          };
        }, moduleUrl);
      console.log(size.width, JSON.stringify(geometry));
      for (const chart of geometry.charts) {
        expect(chart.drawableHeight, chart.name ?? "").toBeGreaterThanOrEqual(
          140,
        );
        expect(chart.top).toBeGreaterThanOrEqual(32);
        expect(chart.bottom).toBeGreaterThanOrEqual(42);
        for (const font of chart.fonts) expect(font).toBeGreaterThanOrEqual(12);
      }
      expect(geometry.horizontal).toBeLessThanOrEqual(1);
      expect(geometry.clipped).toEqual([]);
      expect(geometry.pageScrolling).toBe("visible");
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
      expect(geometry.mainScrolling).toBe("auto");
      if (geometry.mainOverflow > 1)
        expect(geometry.mainOverflow).toBeGreaterThanOrEqual(8);
      await assertShellScrolling(page, `energy drawable ${size.width}`);
      await page.screenshot({
        path: info.outputPath(`energy-${size.width}.png`),
        fullPage: size.width === 390,
      });
      for (const name of ["ems", "environment"]) {
        const host = page.locator(`.energy-${name} .energy-timeseries`);
        await host.scrollIntoViewIfNeeded();
        await expect(host).toBeInViewport({ ratio: 1 });
        await host.screenshot({
          path: info.outputPath(`plot-${name}-${size.width}.png`),
        });
      }
      await page.locator(".energy-alerts").scrollIntoViewIfNeeded();
      await expect(page.locator(".energy-alert-table thead")).toBeInViewport();
      await assertShellScrolling(
        page,
        `energy after main scroll ${size.width}`,
      );
      await page.getByRole("button", { name: "楼层与电梯" }).click();
      await expect(page.locator(".floors-page")).toBeVisible();
      expect(
        await page
          .locator("main")
          .evaluate((main) => main.style.getPropertyValue("overflow-y")),
      ).toBe("");
    });
  });
}
