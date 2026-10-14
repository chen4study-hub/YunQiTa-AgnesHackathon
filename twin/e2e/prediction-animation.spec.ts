import { test, expect } from "@playwright/test";
import { setTimelineHour } from "./timeline-helper";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const width of [390, 1366, 1600, 1920, 1280]) {
  test(`prediction updates tween numbers, retain chart instance and transition tones ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width,
      height:
        width === 390
          ? 844
          : width === 1366
            ? 768
            : width === 1600
              ? 830
              : width === 1280
                ? 664
                : 1080,
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?source=mock&at=2026-10-12T14:00");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    const result = await page.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) => /\/deps\/echarts\.js/.test(name))!;
      const echarts = await import(moduleUrl);
      const host = document.querySelector<HTMLElement>(
        ".replay-chart .echart",
      )!;
      const chart = echarts.getInstanceByDom(host)!;
      const id = chart.id;
      let merges = 0,
        bad = 0;
      const original = chart.setOption.bind(chart);
      chart.setOption = ((...args: unknown[]) => {
        merges++;
        const options = args[1] as { notMerge?: boolean };
        if (options?.notMerge !== false) bad++;
        return (original as (...a: unknown[]) => void)(...args);
      }) as typeof chart.setOption;
      (window as any).__predictionChart = {
        id,
        host,
        chart,
        stats: () => ({ merges, bad }),
      };
      return { id, animation: chart.getOption().animation };
    });
    expect(result.animation).toBe(true);
    const number = page
      .locator(".overview-metric .animated-number-text")
      .first();
    const old = await number.innerText();
    await setTimelineHour(page, 10);
    const samples = await number.evaluate(
      (el) =>
        new Promise<string[]>((resolve) => {
          const values: string[] = [];
          const start = performance.now();
          const tick = (now: number) => {
            values.push(el.textContent || "");
            if (now - start > 420) resolve(values);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const target = await number.getAttribute("data-target");
    expect(samples.at(-1)).toBe(target);
    console.log(
      "ANIMATION_SAMPLES " +
        JSON.stringify({
          width,
          phase: "overview",
          distinct: new Set(samples).size,
          samples,
        }),
    );
    expect(new Set(samples).size).toBeGreaterThan(2);
    expect(target).not.toBe(old);
    // Chart retention is an hourly-update contract, not a full-document navigation contract.
    const identity = await page.evaluate(() => {
      const saved = (window as any).__predictionChart;
      return {
        ...saved.stats(),
        same: document.querySelector(".replay-chart .echart") === saved.host,
        id: saved.chart.id,
        animation: saved.chart.getOption().animation,
      };
    });
    expect(identity.same).toBe(true);
    expect(identity.id).toBe(result.id);
    expect(identity.merges).toBeGreaterThan(1);
    expect(identity.bad).toBe(0);
    expect(identity.animation).toBe(true);
    // The old day buttons are gone. Load the holiday using the public at override,
    // then cross its non-rejected/rejected hours within this document to audit tone tweening.
    await page.goto("/?source=mock&at=2026-10-01T00:00");
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".model-status strong")).toHaveText("正常");
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const el = document.querySelector(".model-status strong")!;
      (window as any).__toneSamples = [];
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const start = performance.now();
        const sample = (now: number) => {
          (window as any).__toneSamples.push(getComputedStyle(el).color);
          if (now - start < 350) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      observer.observe(el.parentElement!, {
        attributes: true,
        attributeFilter: ["class"],
      });
    });
    await setTimelineHour(page, 10);
    await expect(page.locator(".model-status strong")).toHaveText("拒绝预测");
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await page.waitForTimeout(400);
    const toneSamples: string[] = await page.evaluate(
      () => (window as any).__toneSamples,
    );
    console.log(
      "ANIMATION_SAMPLES " +
        JSON.stringify({
          width,
          phase: "tone",
          distinct: new Set(toneSamples).size,
          samples: toneSamples,
        }),
    );
    expect(new Set(toneSamples).size).toBeGreaterThan(2);
    const tones = await page
      .locator(".model-status strong,.dispatch-banner")
      .evaluateAll((es) =>
        es.map((el) => ({
          duration: getComputedStyle(el).transitionDuration,
          property: getComputedStyle(el).transitionProperty,
        })),
      );
    expect(
      tones.every(
        (t) => t.duration.includes("0.28s") && t.property.includes("color"),
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "预测与风险", exact: false })
      .click();
    const forecast = page.locator(".forecast-metric .smooth-value").first();
    await expect(forecast).toBeVisible();
    const chartId = await page
      .locator('.forecast-plot[role="img"]')
      .first()
      .getAttribute("_echarts_instance_");
    await setTimelineHour(page, 14);
    const forecastSamples = await forecast.evaluate(
      (el) =>
        new Promise<string[]>((resolve) => {
          const values: string[] = [];
          const start = performance.now();
          const tick = (now: number) => {
            values.push(el.textContent || "");
            if (now - start > 350) resolve(values);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(new Set(forecastSamples).size).toBeGreaterThan(2);
    expect(
      await page
        .locator('.forecast-plot[role="img"]')
        .first()
        .getAttribute("_echarts_instance_"),
    ).toBe(chartId);
    expect(await forecast.innerText()).toBe(
      await forecast.getAttribute("aria-label"),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "总览", exact: false }).click();
    await setTimelineHour(page, 12);
    await expect
      .poll(async () => await number.innerText())
      .toBe(await number.getAttribute("data-target"));
    expect(
      await page
        .locator(".model-status strong")
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe("0s");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
