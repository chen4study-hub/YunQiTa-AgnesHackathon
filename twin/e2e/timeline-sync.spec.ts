import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
for (const width of [1920, 390]) {
  test(`playing hour frame and minute cursor agree with clock ${width}`, async ({
    page,
  }) => {
    test.setTimeout(30000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?source=mock");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await setTimelineHour(page, 10);
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "10");
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    const samples = await page.evaluate(
      () =>
        new Promise<{
          frames: number;
          stable: number;
          moving: number;
          aligned: number;
          errors: string[];
        }>((resolve) => {
          const result = {
            frames: 0,
            stable: 0,
            moving: 0,
            aligned: 0,
            errors: [] as string[],
          };
          const start = performance.now();
          let lastHour = -1,
            crossedAt = -1000;
          const sample = (now: number) => {
            const clock = document
              .querySelector(".clock")!
              .textContent!.match(/(\d{2}):(\d{2}):(\d{2})$/)!;
            const hour = Number(clock[1]),
              minute = Number(clock[2]) + Number(clock[3]) / 60;
            const timeline = document.querySelector(".timeline")!;
            const current = timeline.querySelector<HTMLElement>(".current")!;
            const cell = current.getBoundingClientRect();
            const slider = timeline
              .querySelector(".timeline-slider")!
              .getBoundingClientRect();
            const cursor = timeline
              .querySelector(".timeline-cursor")!
              .getBoundingClientRect();
            const css = getComputedStyle(
              timeline.querySelector(".timeline-slider")!,
              "::before",
            );
            if (hour !== lastHour) {
              lastHour = hour;
              crossedAt = now;
            }
            result.frames++;
            if (
              Number(current.dataset.hour) !== hour ||
              Math.floor(Number(timeline.getAttribute("aria-valuenow"))) !==
                hour
            )
              result.errors.push("current hour disagrees");
            // translateX(%) uses the cursor's fractional border-box width, not
            // the cell's integer-rounded clientWidth (notably different at 390px).
            const cursorMinutes = ((cursor.x - slider.x) / cursor.width) * 60;
            if (Math.abs(cursorMinutes - minute) > 2)
              result.errors.push(`minute ${cursorMinutes}/${minute}`);
            if (Math.abs(slider.x - cell.x) <= 1.5) result.aligned++;
            if (now - crossedAt > 80) {
              result.stable++;
              if (
                Math.abs(slider.x - cell.x) > 1.5 ||
                Math.abs(parseFloat(css.width) - cell.width) > 1.5
              )
                result.errors.push(`hour frame ${slider.x}/${cell.x}`);
            } else result.moving++;
            if (now - start >= 10000) resolve(result);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    expect(samples.frames).toBeGreaterThan(100);
    // Only the brief hour-boundary catch-up may move the frame between cells.
    expect(samples.aligned / samples.frames).toBeGreaterThan(0.9);
    expect(samples.stable).toBeGreaterThan(100);
    expect(samples.errors.slice(0, 10)).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .locator(".timeline-slider")
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe("0s");
  });
}
