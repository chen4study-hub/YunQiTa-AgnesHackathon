import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.use({ timezoneId: "Asia/Shanghai" });
test("mobile timeline and clock use the same frame through the hour, and verdict bottom blank stays below 25px", async ({
  page,
}) => {
  test.setTimeout(90000);
  await freezeTestHmr(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?source=file&at=2026-10-12T13:59:59", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".dispatch-note")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const bottomBlank = await page
    .locator(".agent-verdict")
    .evaluate(
      (card) =>
        card.getBoundingClientRect().bottom -
        card.querySelector(".dispatch-note")!.getBoundingClientRect().bottom,
    );
  console.log("390px verdict bottom blank:", bottomBlank);
  expect(bottomBlank).toBeLessThan(25);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  const samples = await page.evaluate(async () => {
    const rows: {
      timelineMs: number;
      clockMs: number;
      minute: number;
      clock: string;
      aria: string | null;
    }[] = [];
    for (let i = 0; i < 90; i++) {
      await new Promise(requestAnimationFrame);
      const timeline = document.querySelector<HTMLElement>(".timeline")!,
        clock = document.querySelector<HTMLElement>("time.clock")!;
      rows.push({
        timelineMs: Number(timeline.dataset.nowMs),
        clockMs: Number(clock.dataset.nowMs),
        minute: (Number(timeline.dataset.headTime) % 1) * 60,
        clock: clock.textContent!,
        aria: timeline.getAttribute("aria-valuetext"),
      });
    }
    return rows;
  });
  expect(samples.length).toBe(90);
  expect(
    samples.some(
      (s) =>
        new Date(s.clockMs).getTime() >=
        Date.parse("2026-10-12T14:00:00+08:00"),
    ),
  ).toBe(true);
  for (const sample of samples) {
    expect(sample.timelineMs).toBe(sample.clockMs);
    expect(sample.aria).toBe(sample.clock);
    const date = new Date(sample.clockMs);
    // Node's timezone differs from the browser; epoch modulo covers local minutes/seconds in both.
    const minute = (sample.clockMs % 3600000) / 60000;
    expect(sample.minute).toBeCloseTo(minute, 6);
    expect(Number.isFinite(date.getTime())).toBe(true);
  }
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
});
