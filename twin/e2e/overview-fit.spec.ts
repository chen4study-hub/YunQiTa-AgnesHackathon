import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { setTimelineHour } from "./timeline-helper";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const [width, height, dpr = 1] of [
  [1366, 768],
  [DESKTOP_125.width, DESKTOP_125.height, DESKTOP_125.dpr],
  [1920, 1080],
]) {
  test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`overview fits readable content at ${width}x${height}`, async ({
    page,
  }, info) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width, height });
    await page.route("**/api/**", (r) => r.abort());
    for (const date of ["2026-10-12", "2026-07-13", "2026-10-01"]) {
      await page.goto(`/?source=file&at=${date}T00:00`);
      await expect(page.locator(".overview-metric")).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      await setTimelineHour(page, 0);
      let baseline: number[][] | undefined;
      let maxBody = 0,
        maxCard = 0,
        maxScroll = 0;
      for (let hour = 0; hour < 24; hour++) {
        if (hour)
          await page
            .getByRole("slider", { name: "24 小时时间轴" })
            .press("ArrowRight");
        await expect(page.locator(".timeline")).toHaveAttribute(
          "data-time",
          String(hour),
        );
        await page.waitForTimeout(80);
        const sizes = await page.evaluate(() => {
          const main = document.querySelector("main")!,
            mr = main.getBoundingClientRect();
          const nodes = [
            ...document.querySelectorAll<HTMLElement>(
              ".overview-grid .card,.overview-scene",
            ),
          ];
          const body = document.querySelector(".verdict-body")!;
          return {
            scroll: main.scrollHeight - main.clientHeight,
            body: body.scrollHeight,
            card: document.querySelector(".agent-verdict")!.clientHeight,
            boxes: nodes.map((el) => {
              const r = el.getBoundingClientRect();
              return [r.x, r.y - mr.y + main.scrollTop, r.width, r.height];
            }),
            overflow: nodes
              .filter(
                (el) =>
                  el.scrollHeight > el.clientHeight + 1 ||
                  el.scrollWidth > el.clientWidth + 1,
              )
              .map((el) => ({
                class: el.className,
                dy: el.scrollHeight - el.clientHeight,
                dx: el.scrollWidth - el.clientWidth,
              })),
            fonts: [
              ...document.querySelectorAll<HTMLElement>(
                ".overview-grid p,.overview-grid li,.overview-grid h2,.overview-grid small",
              ),
            ]
              .filter((el) => el.checkVisibility())
              .map((el) => ({
                text: el.textContent!,
                size: parseFloat(getComputedStyle(el).fontSize),
              })),
            horizontal: main.scrollWidth - main.clientWidth,
          };
        });
        maxScroll = Math.max(maxScroll, sizes.scroll);
        maxBody = Math.max(maxBody, sizes.body);
        maxCard = Math.max(maxCard, sizes.card);
        await assertShellScrolling(page, `overview ${width}/${date}/${hour}`);
        expect(sizes.horizontal).toBeLessThanOrEqual(1);
        expect(sizes.overflow, `${date}/${hour}`).toEqual([]);
        expect(sizes.fonts.filter((f) => f.size < 14)).toEqual([]);
        baseline ??= sizes.boxes;
        sizes.boxes.forEach((box, i) =>
          box.forEach((v, j) =>
            expect(v, `${date}/${hour}/${i}/${j}`).toBeCloseTo(
              baseline![i][j],
              1,
            ),
          ),
        );
      }
      console.log(width, date, JSON.stringify({ maxBody, maxCard, maxScroll }));
      if (date === "2026-10-12")
        await page.screenshot({ path: info.outputPath(`overview-fit-${width}.png`) });
    }
  });
  });
}
