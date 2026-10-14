import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`page fixed forecast ${size.width}`, () => {
    test.use({
      viewport: size,
      deviceScaleFactor: size.dpr,
      timezoneId: "Asia/Shanghai",
    });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("fixed public window reveals only played actuals, keeps every red slot and moves the continuous head", async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      await page.clock.install({ time: new Date("2026-10-12T22:30:00+08:00") });
      await page.clock.pauseAt(new Date("2026-10-12T22:30:00+08:00"));
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T22:30");
      await page.getByRole("button", { name: "预测与风险" }).click();
      const host = page.locator(".forecast-window-plot");
      await expect(host).toHaveAttribute("_echarts_instance_", /./);
      const read = () =>
        host.evaluate(async (el) => {
          const source = await (
            await fetch("/src/pages/forecast/Plot.tsx")
          ).text();
          const url = source.match(
            /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
          )![1];
          const e = await import(url);
          const instance = e.getInstanceByDom(el),
            option = instance.getOption();
          return {
            id: el.getAttribute("_echarts_instance_"),
            axis: [option.xAxis[0].min, option.xAxis[0].max],
            red: option.series.find((s: any) => s.id === "forecast-future")
              .markArea.data,
            actual: option.series.find((s: any) => s.id === "forecast-actual")
              .data,
            forecast: option.series.find((s: any) => s.id === "forecast-future")
              .data,
            pixel: instance.convertToPixel(
              { xAxisIndex: 0 },
              Number(
                el
                  .parentElement!.querySelector(".forecast-window-playhead")
                  ?.getAttribute("data-head"),
              ),
            ),
          };
        });
      const facts = await page.evaluate(async () => {
        const d = await (await fetch("/replay/normal.json")).json();
        return d.hours.map((h: any) => ({
          actual: h.actual_kw,
          abstain: h.abstain,
        }));
      });
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.clock.runFor(32);
      const first = await read();
      expect(first.axis).toEqual([21, 46]);
      expect(first.actual.filter((p: any) => p[1] !== null)).toHaveLength(2);
      for (const step of [1000, 1000, 1000, 1000]) {
        await page.clock.runFor(step);
        const state = await read();
        expect(state.axis).toEqual(first.axis);
        expect(state.id).toBe(first.id);
        expect(state.red).toEqual(first.red);
        const head = Number(
          await page
            .locator(".forecast-window-playhead")
            .getAttribute("data-head"),
        );
        expect(head).toBeGreaterThan(22.5);
        for (const [t, value] of state.actual) {
          expect(value).toBe(
            t <= Math.floor(head) ? facts[((t % 24) + 24) % 24].actual : null,
          );
        }
        const position = await page
          .locator(".forecast-window-playhead")
          .evaluate((el) =>
            Number(el.style.transform.match(/translateX\(([^p]+)px\)/)![1]),
          );
        expect(position).toBeCloseTo(state.pixel, 1);
      }
      const before = Number(
        await page
          .locator(".forecast-window-playhead")
          .getAttribute("data-head"),
      );
      await page.clock.runFor(100);
      expect(
        Number(
          await page
            .locator(".forecast-window-playhead")
            .getAttribute("data-head"),
        ),
      ).toBeGreaterThan(before);
      await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
      const paused = await page
        .locator(".forecast-window-playhead")
        .getAttribute("data-head");
      await page.clock.runFor(100);
      expect(
        await page
          .locator(".forecast-window-playhead")
          .getAttribute("data-head"),
      ).toBe(paused);
      await info.attach("fixed-midnight-forecast", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.clock.runFor(21000);
      await expect(
        page.getByRole("button", { name: "↺ 重置", exact: true }),
      ).toBeVisible();
      const end = await read();
      expect(end.axis).toEqual(first.axis);
      expect(end.red).toEqual(first.red);
      expect(end.actual.every((p: any) => p[1] !== null)).toBe(true);
      expect(end.forecast.every((p: any) => p[1] === null)).toBe(true);
      await page.getByRole("button", { name: "↺ 重置", exact: true }).click();
      await expect(page.locator(".forecast-window-playhead")).toHaveCount(0);
      expect((await read()).axis).toEqual([-1, 24]);
    });
  });
  });
