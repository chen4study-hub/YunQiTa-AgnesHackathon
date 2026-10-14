import { test, expect, type Page } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });
async function position(page: Page) {
  return page.locator(".timeline").evaluate((root) => {
    const slider = root
      .querySelector(".timeline-slider")!
      .getBoundingClientRect();
    const cursor = root
      .querySelector(".timeline-cursor")!
      .getBoundingClientRect();
    const selected = root.querySelector<HTMLElement>(".timeline-cell.current")!;
    const clock = document
      .querySelector(".clock")!
      .textContent!.match(/(\d{2}):(\d{2}):(\d{2})$/)!;
    // The transform travels the full slider/cell border-box width, not clientWidth.
    return {
      minute: ((cursor.left - slider.left) / slider.width) * 60,
      clockMinute: Number(clock[2]) + Number(clock[3]) / 60,
      hour: Number(selected.dataset.hour),
      clockHour: Number(clock[1]),
      fraction: (cursor.left - slider.left) / slider.width,
      aligned: Math.abs(slider.left - selected.getBoundingClientRect().left),
      head: Number((root as HTMLElement).dataset.headTime),
    };
  });
}
for (const width of [320, 390, 1366, 1920])
  test(`live minute head agrees with clock and selected hour starts at zero ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1080 });
    await page.clock.install({ time: new Date("2026-10-12T18:31:00+08:00") });
    await page.clock.pauseAt(new Date("2026-10-12T18:31:00+08:00"));
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/?source=file");
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    const clock = page.getByLabel("当前本地时间");
    await expect(clock).toHaveText("2026-10-12 周一 18:31:00");
    const first = await position(page);
    expect(first.hour).toBe(first.clockHour);
    expect(Math.abs(first.minute - first.clockMinute)).toBeLessThanOrEqual(1);
    expect(first.fraction).toBeCloseTo(31 / 60, 2);
    expect(first.aligned).toBeLessThan(1);
    await page.clock.fastForward(65_000);
    await expect(clock).toHaveText("2026-10-12 周一 18:32:05");
    const later = await position(page);
    expect(Math.abs(later.minute - later.clockMinute)).toBeLessThanOrEqual(1);
    expect(later.minute).toBeGreaterThan(first.minute + 1);
    expect(later.head).toBeGreaterThan(first.head);
    // Click an actual hour block, rather than using any test-only store hooks.
    const timeline = page.getByRole("slider", { name: "24 小时时间轴" });
    const box = (await timeline.boundingBox())!;
    await page.mouse.click(
      box.x + (box.width * 9.5) / 24,
      box.y + box.height / 2,
    );
    await expect(timeline).toHaveAttribute("data-time", "9");
    await expect(clock).toHaveText("2026-10-12 周一 09:00:00");
    const selected = await position(page);
    expect(selected.minute).toBeCloseTo(0, 2);
    expect(selected.hour).toBe(9);
    await page.clock.fastForward(65_000);
    expect((await position(page)).minute).toBeCloseTo(0, 2);
    await page.getByRole("button", { name: "回到当前", exact: true }).click();
    const returned = await position(page);
    expect(returned.hour).toBe(18);
    expect(
      Math.abs(returned.minute - returned.clockMinute),
    ).toBeLessThanOrEqual(1);
    expect(returned.minute).toBeGreaterThan(later.minute);
  });

test("live head wraps to the next hour and midnight with the displayed clock", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-12T23:59:58+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T23:59:58+08:00"));
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?source=file");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  expect((await position(page)).minute).toBeGreaterThan(59);
  await page.clock.fastForward(3000);
  const wrapped = await position(page);
  expect(wrapped.hour).toBe(0);
  expect(Math.abs(wrapped.minute - wrapped.clockMinute)).toBeLessThanOrEqual(1);
  await expect(page.getByLabel("当前本地时间")).toHaveText(
    "2026-10-13 周二 00:00:01",
  );
});
