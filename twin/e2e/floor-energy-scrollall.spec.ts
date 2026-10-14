import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { assertShellScrolling } from "./shell-scroll-policy";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const size of [
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
])
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`scrollall/mobshot floors and energy current-date routes ${size.width}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(size);
    for (const hour of [0, 10, 14, 23]) {
      await page.goto(
        `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
      );
      await expect(page.locator(".bottombar")).toBeVisible();
      for (const [label, root] of [
        ["楼层与电梯", ".floors-page"],
        ["能源与告警", ".energy-page"],
      ]) {
        await page.goto(
          `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
        );
        await expect(page.locator(".bottombar")).toBeVisible();
        await page.getByRole("button", { name: label }).click();
        await expect(page.locator(root)).toBeVisible();
        await page.waitForTimeout(400);
        await assertShellScrolling(page, `${size.width}/${label}/${hour}`);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - innerWidth,
          ),
        ).toBeLessThanOrEqual(1);
        if (size.width > 640) {
          expect(
            await page.evaluate(
              () => document.documentElement.scrollHeight - innerHeight,
            ),
          ).toBeLessThanOrEqual(1);
          const clipping = await page
            .locator(`${root} > .card`)
            .evaluateAll((es) =>
              es.flatMap((e) =>
                ["hidden", "clip"].includes(getComputedStyle(e).overflowY) &&
                e.scrollHeight > e.clientHeight + 3
                  ? [
                      {
                        cls: e.className,
                        height: e.clientHeight,
                        excess: e.scrollHeight - e.clientHeight,
                      },
                    ]
                  : [],
              ),
            );
          expect(clipping).toEqual([]);
        }
      }
    }
  });
  });
