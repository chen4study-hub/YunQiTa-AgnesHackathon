import { freezeTestHmr } from "./shell-scroll-policy";
import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import { assertShellScrolling } from "./shell-scroll-policy";

for (const source of ["file", "mock", "api"]) {
  test(`${source}: frame, playback, retained page state and resize`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?source=${source}&at=2026-10-01T14:00`);
    await expect(page.locator(".credit")).toContainText("BDG2");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    await expect(page.locator(".scene-labels span")).toHaveCount(4);
    await page.getByRole("button", { name: "透视", exact: true }).click();
    await page.getByRole("button", { name: "展开楼层", exact: true }).click();
    await expect(page.locator(".scene-tools button")).toHaveCount(7);

    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".clock")).toContainText(
      "2026-10-01 周四 国庆节",
    );
    await expect(page.locator(".timeline .reject")).not.toHaveCount(0);
    await setTimelineHour(page, 10);
    await page
      .getByRole("button", { name: "Agent 决策", exact: false })
      .click();
    await expect(page.locator("main")).toHaveAttribute("data-page", "agent");
    await expect(page.locator(".overview-persistent")).toBeHidden();
    await expect(page.locator(".clock")).toContainText("10:00");
    await page.getByRole("button", { name: "▶ 播放" }).click();
    // Playback now starts at current local time, independent of the selected hour.
    await expect(page.locator(".timeline")).toHaveAttribute(
      "data-playing",
      "true",
    );
    await expect(page.locator(".clock")).not.toContainText("10:00:00");
    await page.getByRole("button", { name: "Ⅱ 暂停" }).click();
    for (const size of [
      { width: 1366, height: 768 },
      { width: 900, height: 1200 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(async () =>
          page.locator(".dashboard").evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              Math.abs(bounds.width - document.body.clientWidth) < 1 &&
              (innerWidth <= 1180
                ? bounds.height >= innerHeight
                : Math.abs(bounds.height - innerHeight) < 1) &&
              getComputedStyle(element.parentElement!).transform === "none"
            );
          }),
        )
        .toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await assertShellScrolling(page, `${source}/${size.width}`);
    }
    expect(errors).toEqual([]);
  });
}
