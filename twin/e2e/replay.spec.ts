import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
test("play from absolute current time completes 24 hours; pause retains cursor and reset returns origin", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?source=mock&at=2026-10-12T14:00");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  await setTimelineHour(page, 21);
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "21");
  await page.clock.install();
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.clock.runFor(300);
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  const paused = Number(
    await page.locator(".timeline").getAttribute("data-time"),
  );
  // Playback starts at the absolute route origin, not the selected 21:00.
  expect(paused).toBeGreaterThan(14);
  expect(paused).toBeLessThan(15);
  const elapsed = Number(
    await page.locator(".timeline").getAttribute("data-elapsed-hours"),
  );
  await page.clock.runFor(300);
  expect(
    Number(await page.locator(".timeline").getAttribute("data-time")),
  ).toBe(paused);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await page.clock.fastForward(Math.ceil((24 - elapsed) * 1000) + 32);
  await expect(page.locator(".timeline")).toHaveAttribute(
    "data-elapsed-hours",
    "24",
  );
  await expect(page.locator(".clock")).toContainText(
    "2026-10-13 周二 14:00:00",
  );
  await expect(
    page.getByRole("button", { name: "↺ 重置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "↺ 重置", exact: true }).click();
  await expect(page.locator(".clock")).toContainText(
    "2026-10-12 周一 14:00:00",
  );
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "14");
  await expect(
    page.getByRole("button", { name: "▶ 播放", exact: true }),
  ).toBeVisible();
});
