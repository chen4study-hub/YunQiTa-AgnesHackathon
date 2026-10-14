import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
])
  test.describe(`actions ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("actions use candidate-column space and remain fully visible", async ({
      page,
    }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(page.locator(".agent-actions button")).toHaveCount(3);
      const m = await page.locator(".agent-left-slot").evaluate((e) => {
        const box = e.getBoundingClientRect(),
          table = e
            .querySelector(".agent-comparison table")!
            .getBoundingClientRect();
        return {
          box: box.toJSON(),
          height: e.clientHeight,
          scroll: e.scrollHeight,
          table: table.toJSON(),
          actions: [...e.querySelectorAll(".agent-actions button")].map(
            (b) => ({
              inComparison: !!b.closest(".agent-comparison"),
              box: b.getBoundingClientRect().toJSON(),
            }),
          ),
        };
      });
      if (size.width >= 1600) {
        expect(m.scroll).toBeLessThanOrEqual(m.height + 1);
        for (const a of m.actions) {
          expect(a.inComparison).toBe(true);
          expect(a.box.top).toBeGreaterThanOrEqual(m.table.bottom);
          expect(a.box.bottom).toBeLessThanOrEqual(m.box.bottom);
        }
      } else {
        for (const a of m.actions) expect(a.inComparison).toBe(false);
      }
      await page.getByRole("button", { name: "查看执行回执" }).click();
      await expect(
        page.getByRole("dialog", { name: "执行回执", exact: true }),
      ).toBeVisible();
    });
  });
  });
