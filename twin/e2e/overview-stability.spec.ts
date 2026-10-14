import { freezeTestHmr } from "./shell-scroll-policy";
import { setTimelineHour } from "./timeline-helper";
import { test, expect, type Page } from "@playwright/test";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import {
  assertShellScrolling,
  installScrollInspector,
} from "./shell-scroll-policy";

async function layout(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main")!;
    const cards = [
      ...document.querySelectorAll(".overview-grid .card, .overview-scene"),
    ].map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    return {
      height: root.scrollHeight,
      width: root.scrollWidth,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      mainHeight: main.clientHeight,
      mainScroll: main.scrollHeight,
      cards,
    };
  });
}
type Sampling = { frames: number; violations: string[]; raf: number };
async function startSampling(page: Page) {
  await installScrollInspector(page);
  await page.evaluate(() => {
    const baseline = [
      ...document.querySelectorAll(".overview-grid .card, .overview-scene"),
    ].map((el) => el.getBoundingClientRect());
    const probe: Sampling = { frames: 0, violations: [], raf: 0 };
    (window as unknown as { stabilityProbe: Sampling }).stabilityProbe = probe;
    const sample = () => {
      probe.frames++;
      const main = document.querySelector("main")!;
      const errors: string[] = [];
      const scrollErrors = (
        window as typeof window & { __inspectShellScrolling: () => unknown[] }
      ).__inspectShellScrolling();
      if (scrollErrors.length) errors.push(JSON.stringify(scrollErrors));
      if (
        document.documentElement.scrollWidth > innerWidth ||
        main.scrollWidth > main.clientWidth
      )
        errors.push("horizontal overflow");
      [
        ...document.querySelectorAll(".overview-grid .card, .overview-scene"),
      ].forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        for (const key of ["x", "y", "width", "height"] as const) {
          if (Math.abs(rect[key] - baseline[i][key]) > 0.05)
            errors.push(`card ${i} ${key}: ${rect[key]}/${baseline[i][key]}`);
        }
      });
      if (errors.length && probe.violations.length < 10)
        probe.violations.push(`frame ${probe.frames}: ${errors.join(", ")}`);
      probe.raf = requestAnimationFrame(sample);
    };
    sample();
  });
}
async function assertSampling(page: Page) {
  const probe = await page.evaluate(() => {
    const probe = (window as unknown as { stabilityProbe: Sampling })
      .stabilityProbe;
    cancelAnimationFrame(probe.raf);
    return probe;
  });
  expect(probe.frames).toBeGreaterThan(100);
  expect(probe.violations).toEqual([]);
}
for (const size of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(`24 hours x 3 days have invariant geometry and near-zero CLS ${size.width}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize(size);
    await page.addInitScript(() => {
      (window as unknown as { measuredCLS: number }).measuredCLS = 0;
      let start = 0,
        last = 0,
        windowScore = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          // Standard CLS: largest 5-second session window, excluding recent input.
          // The independent rAF probe still checks every clicked animation frame.
          if (shift.hadRecentInput) continue;
          if (shift.startTime - last > 1000 || shift.startTime - start > 5000) {
            start = shift.startTime;
            windowScore = 0;
          }
          last = shift.startTime;
          windowScore += shift.value;
          (window as unknown as { measuredCLS: number }).measuredCLS = Math.max(
            (window as unknown as { measuredCLS: number }).measuredCLS,
            windowScore,
          );
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    let initial: Awaited<ReturnType<typeof layout>> | undefined;
    // Dates, not removed scenario buttons, drive workday/summer/holiday data.
    for (const day of ["2026-10-12", "2026-07-13", "2026-10-01"]) {
      await page.goto(`/?source=file&at=${day}T14:00`);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      await expect(page.locator(".twin-scene canvas")).toBeVisible({
        timeout: 15000,
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      // Sample steady-state geometry, not the phased initial card entrance.
      await page.locator(".overview-grid").evaluate(async (el) => {
        await Promise.all(
          el
            .getAnimations({ subtree: true })
            .filter(
              (a) => a.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((a) => a.finished),
        );
      });
      initial ??= await layout(page);
      await startSampling(page);
      await page.evaluate(() => {
        (window as unknown as { measuredCLS: number }).measuredCLS = 0;
      });
      await expect(page.getByLabel("当前本地日期")).toContainText(day);
      for (let hour = 0; hour < 24; hour++) {
        // Sequential hour sweep avoids replaying Home + N inputs for each cell.
        if (hour === 0) await setTimelineHour(page, 0);
        else
          await page
            .getByRole("slider", { name: "24 小时时间轴" })
            .press("ArrowRight");
        await expect(page.locator(".timeline")).toHaveAttribute(
          "data-time",
          String(hour),
        );
        const current = await layout(page);
        await assertShellScrolling(page, `${day}/${hour}`);
        expect(current.width).toBeLessThanOrEqual(size.width);

        expect(current.cards).toHaveLength(initial!.cards.length);
        current.cards.forEach((card, i) => {
          for (const key of ["x", "y", "width", "height"] as const)
            expect(card[key], `${day}/${hour}/card ${i}/${key}`).toBeCloseTo(
              initial!.cards[i][key],
              1,
            );
        });
      }
      await assertSampling(page);
      const cls = await page.evaluate(
        () => (window as unknown as { measuredCLS: number }).measuredCLS,
      );
      expect(cls).toBeLessThan(0.001);
    }
  });
  test(`20 seconds playback samples every frame with only necessary vertical scroll ${size.width}`, async ({
    page,
  }) => {
    test.setTimeout(45000);
    await page.setViewportSize(size);
    await page.goto("/?source=file&at=2026-10-01T14:00");
    await expect(page.locator(".twin-scene canvas")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByLabel("当前本地日期")).toHaveText(
      "2026-10-01 周四 国庆节",
    );
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await setTimelineHour(page, 0);
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "0");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await startSampling(page);
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await page.waitForTimeout(20000);
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    expect(
      Number(await page.locator(".timeline").getAttribute("data-time")),
    ).toBeGreaterThan(10);
    await assertSampling(page);
  });
}

test("20 seconds playback and hidden-chart return have no browser errors or reload", async ({
  page,
}) => {
  test.setTimeout(45000);
  const errors: string[] = [],
    warnings: string[] = [],
    failed: string[] = [];
  let documents = 0;
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (
      message.type() === "warning" &&
      /ResizeObserver|ECharts|width|height/i.test(message.text())
    )
      warnings.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      failed.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents++;
  });
  await page.goto("/?source=file");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await setTimelineHour(page, 0);
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "0");
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.waitForTimeout(10000);
  await page.getByRole("button", { name: "关于 ABOUT" }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "总览 OVERVIEW" }).click();
  await page.waitForTimeout(10000);
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  expect(
    Number(await page.locator(".timeline").getAttribute("data-time")),
  ).toBeGreaterThan(10);
  expect(
    (await page.locator(".overview-forecast .echart canvas").boundingBox())!
      .width,
  ).toBeGreaterThan(100);
  expect(documents).toBe(1);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
  expect(failed).toEqual([]);
});
