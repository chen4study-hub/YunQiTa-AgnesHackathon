import { DESKTOP_125 } from "./viewport-profile";
import { test, expect, type Page } from "@playwright/test";
const sizes = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
];
async function selection(page: Page) {
  return page.locator(".timeline").evaluate((root) => {
    const selected = root
      .querySelector(".timeline-cell.current")!
      .getBoundingClientRect();
    const overlay = root
      .querySelector(".timeline-slider")!
      .getBoundingClientRect();
    const cursor = root
      .querySelector(".timeline-cursor")!
      .getBoundingClientRect();
    const date = root
      .querySelector(".timeline-date-label")!
      .getBoundingClientRect();
    const css = getComputedStyle(
      root.querySelector(".timeline-slider")!,
      "::before",
    );
    return {
      differences: ["left", "top", "right", "bottom", "width", "height"].map(
        (k) =>
          (overlay[k as keyof DOMRect] as number) -
          (selected[k as keyof DOMRect] as number),
      ),
      cursorTop: cursor.top - selected.top,
      cursorBottom: cursor.bottom - selected.bottom,
      minute: (cursor.left - overlay.left) / overlay.width,
      head: Number((root as HTMLElement).dataset.headTime) % 1,
      border: [
        parseFloat(css.width) - selected.width,
        parseFloat(css.height) - selected.height,
      ],
      dateGap: date.top - selected.bottom,
    };
  });
}
async function assertSelection(page: Page) {
  await expect
    .poll(async () =>
      Math.max(...(await selection(page)).differences.map(Math.abs)),
    )
    .toBeLessThan(0.05);
  const sample = await selection(page);
  for (const delta of [...sample.border, sample.cursorTop, sample.cursorBottom])
    expect(Math.abs(delta)).toBeLessThan(0.05);
  expect(sample.minute).toBeCloseTo(sample.head, 3);
  expect(sample.dateGap).toBeGreaterThanOrEqual(0);
}
for (const size of sizes)
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`selection follows real cell bounds ${size.width}x${size.height}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(size);
    await page.route("**/api/**", (r) => r.abort());
    await page.goto("/?source=file&at=2026-10-12T18:31", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".overview-metric")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    await assertSelection(page);
    const slider = page.getByRole("slider", { name: "24 小时时间轴" });
    await slider.focus();
    await slider.press("Home");
    for (let hour = 0; hour < 24; hour++) {
      if (hour) await slider.press("ArrowRight");
      await expect(slider).toHaveAttribute("data-time", String(hour));
      await assertSelection(page);
    }
    // Resize and change the actual track geometry: no row-height or gap guess can pass.
    await page.setViewportSize({
      width: size.width === 390 ? 420 : size.width - 20,
      height: size.height,
    });
    await assertSelection(page);
    await page.addStyleTag({
      content:
        ".responsive-dashboard .bottombar .timeline{padding-top:7px;--timeline-gap:2px}.responsive-dashboard .bottombar .timeline .timeline-cell{height:51px;min-height:51px}",
    });
    await assertSelection(page);
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await page.waitForTimeout(500);
    await assertSelection(page);
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  });
  });

test("1920 overview fits the main track without phantom scrolling", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/api/**", (r) => r.abort());
  for (const date of ["2026-10-12", "2026-07-13", "2026-10-01"]) {
    await page.goto(`/?source=file&at=${date}T00:00`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".overview-metric")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const slider = page.getByRole("slider", { name: "24 小时时间轴" });
    await slider.focus();
    await slider.press("Home");
    for (let hour = 0; hour < 24; hour++) {
      if (hour) await slider.press("ArrowRight");
      await expect(slider).toHaveAttribute("data-time", String(hour));
      await page.waitForTimeout(60);
      const metrics = await page
        .locator("main")
        .evaluate((main) => ({
          client: main.clientHeight,
          scroll: main.scrollHeight,
          width: main.clientWidth,
          scrollWidth: main.scrollWidth,
          clipped: [
            ...main.querySelectorAll<HTMLElement>(".card,.overview-scene"),
          ]
            .filter((el) => el.scrollHeight > el.clientHeight + 1)
            .map((el) => el.className),
          font: parseFloat(
            getComputedStyle(main.querySelector(".agent-verdict p")!).fontSize,
          ),
          chart: main
            .querySelector(".overview-forecast .replay-chart")!
            .getBoundingClientRect().height,
        }));
      expect(metrics.scroll, `${date}/${hour} unnecessary main scrolling`).toBe(
        metrics.client,
      );
      expect(metrics.scrollWidth).toBe(metrics.width);
      expect(metrics.clipped).toEqual([]);
      expect(metrics.font).toBeGreaterThanOrEqual(15);
      expect(metrics.chart).toBeGreaterThanOrEqual(200);
    }
  }
  // Smaller main viewport genuinely needs scroll; never hide overflow to mask it.
  await page.setViewportSize({ width: 1920, height: 830 });
  await expect
    .poll(() =>
      page
        .locator("main")
        .evaluate((main) => main.scrollHeight - main.clientHeight),
    )
    .toBeGreaterThan(0);
  expect(
    await page
      .locator("main")
      .evaluate((main) => getComputedStyle(main).overflowY),
  ).toBe("auto");
});
