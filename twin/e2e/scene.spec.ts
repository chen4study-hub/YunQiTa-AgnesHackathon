import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";

test("overview day, whole-building handoff and night xray", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: info.outputPath("scene-day.png") });
  await page.goto("/?source=file&at=2026-10-01T10:00");
  await setTimelineHour(page, 10);
  await expect(page.locator(".scene-wrapper")).toHaveClass(/handoff/);
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath("scene-handoff.png") });
  await page.goto("/?source=file&at=2026-10-12T20:00");
  await setTimelineHour(page, 20);
  await page.getByRole("button", { name: "透视", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath("scene-night-xray.png") });
  await page.getByRole("button", { name: "展开楼层", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath("scene-exploded.png") });
  expect(errors).toEqual([]);
});
