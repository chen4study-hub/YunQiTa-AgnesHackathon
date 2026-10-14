import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`forecast metric type ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("numbers and units share the baseline, adjacent and left aligned; charts remain sans-serif and one decimal", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const measurements = await page
        .locator(".forecast-metric")
        .evaluateAll((nodes) =>
          nodes
            .filter((e) => e.querySelector(".forecast-unit"))
            .map((e) => {
              const number = e.querySelector("dd > .smooth-value")!,
                unit = e.querySelector(".forecast-unit")!,
                label = e.querySelector("dt")!,
                dd = e.querySelector("dd")!,
                cs = getComputedStyle(dd),
                us = getComputedStyle(unit);
              return {
                unit: unit.textContent,
                text: dd.textContent,
                numberText: number.textContent,
                n: number.getBoundingClientRect().toJSON(),
                u: unit.getBoundingClientRect().toJSON(),
                l: label.getBoundingClientRect().toJSON(),
                font: parseFloat(cs.fontSize),
                ufont: parseFloat(us.fontSize),
                align: cs.alignItems,
                family: cs.fontFamily,
                variants: cs.fontVariantNumeric,
              };
            }),
        );
      expect(measurements.length).toBeGreaterThan(3);
      for (const m of measurements) {
        // faa4164: percentages and kW both require a real text separator.
        expect(m.unit).toMatch(/^[ \u00a0][^ \u00a0]/);
        expect(m.text?.replace(/\u00a0/g, " ")).toBe(
          `${m.numberText} ${m.unit?.slice(1)}`,
        );
        expect(m.n.left).toBe(m.l.left);
        expect(m.n.top).toBeGreaterThanOrEqual(m.l.bottom);
        expect(m.ufont / m.font).toBeGreaterThanOrEqual(0.4);
        expect(m.ufont / m.font).toBeLessThanOrEqual(0.55);
        expect(m.align).toBe("baseline");
        expect(m.family).not.toMatch(/Mono|monospace/);
        expect(m.variants).toBe("tabular-nums");
      }
      const chart = page.locator(".forecast-window-plot");
      const content = await chart.evaluate(async (el) => {
        const source = await (
          await fetch("/src/pages/forecast/Plot.tsx")
        ).text();
        const url = source.match(
          /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
        )![1];
        const echarts = await import(url);
        const instance = echarts.getInstanceByDom(el),
          option = instance.getOption();
        const params = option.series
          .filter((s: any) => s.type === "line" && s.data?.length)
          .map((s: any) => ({
            seriesName: s.name,
            seriesId: s.id,
            dataIndex: 1,
            name: "14:00",
            value: Array.isArray(s.data[1])
              ? s.data[1]
              : s.data[1] !== null && typeof s.data[1] === "object"
                ? s.data[1].value
                : s.data[1],
          }));
        const formatter = option.tooltip[0].formatter;
        const text = typeof formatter === "function" ? formatter(params) : "";
        return {
          family: option.textStyle.fontFamily,
          text,
          labels: instance
            .getZr()
            .storage.getDisplayList()
            .filter((e: any) => e.style?.text)
            .map((e: any) => e.style.fontFamily)
            .filter(Boolean),
        };
      });
      expect(content.family).not.toMatch(/Mono|monospace/);
      expect(content.text).not.toMatch(/\d\.\d{2,}/);
      expect(content.text).not.toBe("");
      expect(
        content.labels.every((f: string) => !/Mono|monospace/.test(f)),
      ).toBe(true);
      const geometry = await page.evaluate(() => ({
        docWidth: document.scrollingElement!.scrollWidth,
        docHeight: document.scrollingElement!.scrollHeight,
        rootHeight: (document.querySelector(".forecast-root") as HTMLElement)
          .clientHeight,
        rootScroll: (document.querySelector(".forecast-root") as HTMLElement)
          .scrollHeight,
      }));
      expect(geometry.docWidth).toBeLessThanOrEqual(size.width);
      await assertShellScrolling(page, "forecast metric readability");
      await info.attach("forecast-type", {
        body: await page.screenshot({
          path: info.outputPath("forecast-type.png"),
          fullPage: true,
        }),
        contentType: "image/png",
      });
    });
  });
  });
