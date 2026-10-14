import { test, expect } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
test.use({
  viewport: { width: 390, height: 844 },
  reducedMotion: "no-preference",
  deviceScaleFactor: 1,
});
test("390 ten real drags keep three chart instances and heights; raw shifts and CLS below 0.01", async ({
  page,
}, info) => {
  await currentUI4183(page);
  await page.goto("/?source=file&scenario=normal&at=2026-10-13T04:00", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: /预测与风险/ }).click();
  await page.evaluate(() => document.fonts.ready);
  const charts = page.locator(
    ".forecast-window-plot, .forecast-confidence-plot, .forecast-floor-plot",
  );
  await expect(charts).toHaveCount(3);
  for (const chart of await charts.all())
    await expect(chart).toHaveAttribute("_echarts_instance_", /./);
  await page.waitForTimeout(600);
  const read = () =>
    charts.evaluateAll((es) =>
      es.map((e) => ({
        id: e.getAttribute("_echarts_instance_"),
        height: e.getBoundingClientRect().height,
      })),
    );
  await page.locator(".forecast-metrics").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const original = await read();
  await page.evaluate(() => {
    const w = window as any;
    w.shifts = [];
    w.moving = [];
    let previous: any[] = [];
    const sample = () => {
      const current = Array.from(
        document.querySelectorAll(
          ".forecast-metric dd,.forecast-metric .forecast-unit,.forecast-metric > small,.forecast-risk-summary-line,.forecast-key,.forecast-heading,.forecast-badge",
        ),
      ).map((e) => {
        const r = e.getBoundingClientRect();
        return {
          class: e.className,
          text: e.textContent,
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
        };
      });
      if (previous.length)
        for (let i = 0; i < current.length; i++)
          if (
            JSON.stringify([
              current[i].x,
              current[i].y,
              current[i].w,
              current[i].h,
            ]) !==
            JSON.stringify([
              previous[i].x,
              previous[i].y,
              previous[i].w,
              previous[i].h,
            ])
          )
            w.moving.push({ previous: previous[i], current: current[i] });
      previous = current;
      w.sample = requestAnimationFrame(sample);
    };
    sample();
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        w.shifts.push({
          value: (e as any).value,
          recent: (e as any).hadRecentInput,
          sources: (e as any).sources?.map((s: any) => ({
            class: s.node?.className,
            text: s.node?.textContent?.slice(0, 120),
            previous: s.previousRect,
            current: s.currentRect,
          })),
        });
    }).observe({ type: "layout-shift", buffered: false });
  });
  const axis = page.locator(".timeline-slider").locator("..");
  const bounds = await axis.boundingBox();
  expect(bounds).not.toBeNull();
  for (let hour = 5; hour < 15; hour++) {
    const b = bounds!,
      x = b.x + (b.width * (hour + 0.1)) / 24,
      y = b.y + b.height / 2;
    await page.mouse.move(x - 5, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(await read()).toEqual(original);
  }
  const shifts = await page.evaluate(
      () => (window as any).shifts as { value: number; recent: boolean }[],
    ),
    raw = shifts.reduce((a, b) => a + b.value, 0),
    cls = shifts.filter((s) => !s.recent).reduce((a, b) => a + b.value, 0);
  await info.attach("layout-shifts", {
    body: JSON.stringify({ raw, cls, shifts, original }),
    contentType: "application/json",
  });
  console.log(
    JSON.stringify({
      raw,
      cls,
      shifts,
      moving: await page.evaluate(() => (window as any).moving),
    }),
  );
  const moving = await page.evaluate(() => {
    const w = window as any;
    cancelAnimationFrame(w.sample);
    return w.moving;
  });
  await info.attach("moving-elements", {
    body: JSON.stringify(moving),
    contentType: "application/json",
  });
  expect(moving).toEqual([]);
  expect(raw, JSON.stringify(shifts)).toBeLessThan(0.01);
  expect(cls).toBeLessThan(0.01);
  await page.screenshot({ path: info.outputPath("390-forecast.png") });
});
