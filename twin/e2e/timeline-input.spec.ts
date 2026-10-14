import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
  DESKTOP_125,
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`one accessible timeline slider, click, continuous drag and keyboard ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    // Fix Date only: freezing timers prevents the deferred 3D initialization.
    await page.clock.setFixedTime(new Date("2026-10-12T14:23:05"));
    await page.goto("/?source=mock&at=2026-10-12T14:23:05");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    const slider = page.getByRole("slider", { name: "24 小时时间轴" });
    await expect(slider).toHaveCount(1);
    await expect(slider.locator('button,[role="button"]')).toHaveCount(0);
    await expect(slider.locator(".timeline-cell")).toHaveCount(24);
    let box = (await slider.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    await slider.click({
      position: { x: (box.width * 10.7) / 24, y: box.height / 2 },
    });
    await expect(slider).toHaveAttribute("aria-valuenow", "10");
    await slider.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "11");
    await slider.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuenow", "10");
    await slider.press("Home");
    await slider.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await slider.press("End");
    await slider.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "23");
    // The compact clock controls may wrap when return-to-current becomes available.
    box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + (box.width * 8) / 24, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + (box.width * 11.5) / 24,
      box.y + box.height / 2,
      { steps: 8 },
    );
    let value = Number(await slider.getAttribute("aria-valuenow"));
    expect(value).toBeCloseTo(11.5, 1);
    expect(value % 1).toBeGreaterThan(0.3);
    await page.mouse.move(
      box.x + (box.width * 12.25) / 24,
      box.y + box.height / 2,
    );
    value = Number(await slider.getAttribute("aria-valuenow"));
    expect(value).toBeCloseTo(12.25, 1);
    // The visible timestamp follows fractional selection, not the real clock.
    const selectedClock = new Date(
      new Date("2026-10-12T00:00:00").getTime() + Math.round(value * 3_600_000),
    );
    const expectedClock = [
      selectedClock.getHours(),
      selectedClock.getMinutes(),
      selectedClock.getSeconds(),
    ]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    await expect(page.locator(".clock")).toContainText(expectedClock);
    await page.mouse.move(box.x + box.width + 25, box.y + box.height / 2);
    await page.mouse.up();
    await expect(slider).toHaveAttribute("aria-valuenow", "23");
    await expect(slider).toHaveAttribute("data-dragging", "false");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  });
}
