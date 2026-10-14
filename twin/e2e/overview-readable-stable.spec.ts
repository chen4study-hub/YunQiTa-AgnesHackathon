import { test, expect } from "@playwright/test";
for (const width of [390, 1366, 1920])
  test(`hourly verdict geometry and mobile text floors ${width}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.route("**/api/**", (r) => r.abort());
    for (const date of ["2026-10-12", "2026-07-13", "2026-10-01"]) {
      await page.goto(`/?source=file&at=${date}T00:00`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".overview-metric")).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      // Measure steady-state layout after the finite entrance, not its last translated frame.
      await page.locator(".overview-grid").evaluate(async (root) => {
        await Promise.all(
          root
            .getAnimations({ subtree: true })
            .filter(
              (a) => a.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((a) => a.finished),
        );
      });
      const slider = page.getByRole("slider", { name: "24 小时时间轴" });
      await slider.focus();
      await slider.press("Home");
      let baseline:
        { x: number; y: number; width: number; height: number }[] | undefined;
      for (let hour = 0; hour < 24; hour++) {
        if (hour) await slider.press("ArrowRight");
        await expect(slider).toHaveAttribute("data-time", String(hour));
        await page.waitForTimeout(100);
        // Main-relative coordinates are unaffected by keyboard focus revealing the timeline.
        const result = await page.evaluate(() => {
          const main = document.querySelector("main")!,
            mr = main.getBoundingClientRect();
          const boxes = [
            ...document.querySelectorAll(".agent-verdict,.overview-forecast"),
          ].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y - mr.y + main.scrollTop,
              width: r.width,
              height: r.height,
            };
          });
          const card = document.querySelector<HTMLElement>(".agent-verdict")!;
          const text: { text: string; size: number; required: number }[] = [];
          for (const [selector, required] of [
            [".brand span", 14],
            [".scene-labels span,.scene-labels b", 12],
            [".scene-tools button", 14],
            [".scene-legend,.scene-legend span", 12],
            [
              ".agent-verdict p,.agent-verdict li,.agent-verdict b,.agent-verdict small,.dispatch-note",
              14,
            ],
          ] as const) {
            for (const el of document.querySelectorAll<HTMLElement>(selector))
              if (el.checkVisibility())
                text.push({
                  text: el.textContent!,
                  size: parseFloat(getComputedStyle(el).fontSize),
                  required,
                });
          }
          return {
            boxes,
            clipped: card.scrollHeight > card.clientHeight + 1,
            text,
            blank: (() => {
              const cr = card.getBoundingClientRect();
              const children = [...card.querySelectorAll("*")].filter(
                (e) => e.checkVisibility() && e.getClientRects().length,
              );
              return (
                cr.bottom -
                Math.max(
                  ...children.map((e) => e.getBoundingClientRect().bottom),
                )
              );
            })(),
          };
        });
        baseline ??= result.boxes;
        if (width !== 390)
          result.boxes.forEach((b, i) => {
            for (const key of ["x", "y", "width", "height"] as const)
              expect(b[key], `${date}/${hour}/${i}/${key}`).toBeCloseTo(
                baseline![i][key],
                1,
              );
          });
        expect(result.clipped, `${date}/${hour} reserved card clips`).toBe(
          false,
        );
        if (width === 390) {
          expect(result.blank, `${date}/${hour} bottom blank`).toBeLessThan(25);
          expect(result.blank).toBeGreaterThanOrEqual(0);
          for (let i = 1; i < result.boxes.length; i++)
            expect(result.boxes[i].y).toBeGreaterThanOrEqual(
              result.boxes[i - 1].y + result.boxes[i - 1].height,
            );
        }
        if (width === 390)
          expect(
            result.text.filter((x) => x.size < x.required),
            `${date}/${hour} undersized text`,
          ).toEqual([]);
      }
    }
  });
