import { expect, test } from "@playwright/test";
import { DESKTOP_125, RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { isolateOpsTest } from "./ops-test-data";

for (const size of [
  DESKTOP_125,
  { width: 1366, height: 768, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`energy aligned axis ticks ${size.width}`, () => {
    test.use({ deviceScaleFactor: size.dpr });
    test("environment and storage/PV axes use uniform ticks with separated labels", async ({
      page,
    }) => {
      test.setTimeout(90000);
      await isolateOpsTest(page);
      await page.setViewportSize(size);
      for (const date of ["2026-10-12", "2026-07-23", "2026-10-01"]) {
        await page.goto(`/?source=file&at=${date}T14:00`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByRole("button", { name: "能源与告警" }).click();
        await expect(page.locator(".energy-timeseries")).toHaveCount(2);
        await page.evaluate(() => document.fonts.ready);
        const source = await (
          await page.request.get("/src/pages/energy/SmoothChart.tsx")
        ).text();
        const url = source.match(/from ["']([^"']*echarts\.js[^"']*)["']/)![1];
        await expect
          .poll(async () =>
            page
              .locator(".energy-timeseries")
              .evaluateAll(async (hosts, url) => {
                const ec = await import(/* @vite-ignore */ url);
                return hosts.every(
                  (host) =>
                    !!ec
                      .getInstanceByDom(host)
                      ?.getModel()
                      .getComponent("grid"),
                );
              }, url),
          )
          .toBe(true);
        const axes = await page
          .locator(".energy-timeseries")
          .evaluateAll(async (hosts, url) => {
            const ec = await import(/* @vite-ignore */ url);
            return hosts.flatMap((host) => {
              const chart = ec.getInstanceByDom(host),
                model = chart.getModel(),
                option = chart.getOption();
              return option.yAxis.map((axis: any, index: number) => {
                const coord = model.getComponent("yAxis", index).axis;
                const ticks = coord.scale
                  .getTicks()
                  .map((tick: any) => tick.value);
                const positions = ticks.map((value: number) =>
                  coord.dataToCoord(value),
                );
                return {
                  chart: host.getAttribute("aria-label"),
                  index,
                  min: axis.min,
                  max: axis.max,
                  interval: axis.interval,
                  ticks,
                  positions,
                  font: axis.axisLabel.fontSize,
                  labels: coord
                    .getViewLabels()
                    .map((label: any) => label.formattedLabel),
                };
              });
            });
          }, url);
        console.log(size.width, date, JSON.stringify(axes));
        expect(axes).toHaveLength(4);
        for (const axis of axes) {
          expect(Number.isInteger(axis.min / axis.interval)).toBe(true);
          expect(Number.isInteger(axis.max / axis.interval)).toBe(true);
          expect(axis.ticks).toEqual([
            axis.min,
            axis.min + axis.interval,
            axis.max,
          ]);
          expect(axis.labels).toHaveLength(3);
          for (let i = 1; i < axis.positions.length; i++) {
            expect(
              Math.abs(axis.positions[i] - axis.positions[i - 1]),
            ).toBeGreaterThanOrEqual(axis.font * 2);
          }
          expect(axis.font).toBeGreaterThanOrEqual(12);
        }
      }
    });
  });
}
