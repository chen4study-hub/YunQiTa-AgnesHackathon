import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { setTimelineHour } from "./timeline-helper";
for (const [width, height, dpr = 1] of [
  [390, 844],
  [1366, 768],
  [DESKTOP_125.width, DESKTOP_125.height, DESKTOP_125.dpr],
  [1920, 1080],
  [2560, 1080],
])
  test.describe(`scene labels ${width}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test(`four backed scene labels are separated and avoid tower ${width}`, async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width, height });
      await page.goto("/?source=file&at=2026-10-12T14:00");
      await expect(page.locator(".twin-scene")).toHaveAttribute(
        "data-render-active",
        "true",
      );
      const check = async () => {
        await page.locator(".twin-scene").scrollIntoViewIfNeeded();
        await expect(page.locator(".twin-scene")).toHaveAttribute(
          "data-scene-ready",
          "true",
          { timeout: 30000 },
        );
        await expect
          .poll(() =>
            page.locator(".scene-labels").evaluate((root) => {
              const area = root.getBoundingClientRect();
              const tower = JSON.parse(
                (root as HTMLElement).dataset.towerBounds || "null",
              );
              if (!tower) return false;
              const labels = [
                ...root.querySelectorAll<HTMLElement>("[data-anchor]"),
              ];
              const rects = labels.map((el) => {
                const r = el.getBoundingClientRect();
                return {
                  left: r.left - area.left,
                  top: r.top - area.top,
                  right: r.right - area.left,
                  bottom: r.bottom - area.top,
                };
              });
              const hits = (a: any, b: any) =>
                a.left < b.right &&
                a.right > b.left &&
                a.top < b.bottom &&
                a.bottom > b.top;
              return (
                labels.length === 4 &&
                labels.every(
                  (el) => getComputedStyle(el).visibility === "visible",
                ) &&
                rects.every(
                  (r, i) =>
                    r.left >= 0 &&
                    r.top >= 0 &&
                    r.right <= area.width &&
                    r.bottom <= area.height &&
                    !hits(r, {
                      left: tower.x,
                      top: tower.y,
                      right: tower.x + tower.width,
                      bottom: tower.y + tower.height,
                    }) &&
                    rects.slice(i + 1).every((other) => !hits(r, other)),
                )
              );
            }),
          )
          .toBe(true);
      };
      await check();
      const styles = await page
        .locator(".scene-labels > [data-anchor]")
        .evaluateAll((es) =>
          es.map((el) => ({
            background: getComputedStyle(el).backgroundColor,
            border: getComputedStyle(el).borderTopWidth,
          })),
        );
      for (const style of styles) {
        expect(style.background).toMatch(/rgba\(/);
        expect(parseFloat(style.border)).toBeGreaterThanOrEqual(1);
      }
      await page.goto("/?source=file&scenario=abstain&at=2026-10-01T10:00");
      await setTimelineHour(page, 10);
      await expect(page.locator(".timeline")).toHaveAttribute(
        "data-time",
        "10",
      );
      await check();
      await page.getByRole("button", { name: "展开楼层", exact: true }).click();
      await page.waitForTimeout(2000);
      await check();
      await expect(
        page.locator('.scene-labels > [data-anchor="tower"]'),
      ).toContainText("转交人工");
      const statusWords = await page
        .locator(".overview-grid .overview-status-word")
        .evaluateAll((elements) =>
          elements
            .filter((el) => getComputedStyle(el).visibility === "visible")
            .map((el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const rects = Array.from(range.getClientRects());
              return {
                text: el.textContent,
                lines: new Set(rects.map((r) => Math.round(r.top))).size,
                nowrap: getComputedStyle(el).whiteSpace,
              };
            }),
        );
      expect(statusWords.some((s) => s.text === "转交人工")).toBe(true);
      expect(statusWords.some((s) => s.text === "待机")).toBe(true);
      expect(statusWords.some((s) => s.text === "转人工复核")).toBe(true);
      for (const s of statusWords) {
        expect(s.nowrap, s.text!).toBe("nowrap");
        expect(s.lines, `${s.text}: status word stays on one line`).toBe(1);
      }
      const power = await page
        .locator(".scene-power-value")
        .evaluateAll((elements) =>
          elements.map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const lines = Array.from(range.getClientRects());
            const label = el.closest("[data-anchor]")!.getBoundingClientRect();
            return {
              text: el.textContent,
              // Font fallback can split a text run into multiple rectangles on one line.
              lines: new Set(lines.map((r) => Math.round(r.top))).size,
              fits: lines.every(
                (r) => r.left >= label.left && r.right <= label.right,
              ),
              font: parseFloat(getComputedStyle(el).fontSize),
            };
          }),
        );
      expect(power).toHaveLength(4);
      for (const p of power) {
        expect(p.text).toMatch(/\d+\.\d kW/);
        expect(
          p.lines,
          `${p.text}: numeric value and unit stay on one line`,
        ).toBe(1);
        expect(p.fits).toBe(true);
        expect(p.font).toBeGreaterThanOrEqual(12);
      }
      await page
        .locator(".overview-scene")
        .screenshot({ path: info.outputPath("holiday-expanded.png") });
      if (width === 390) {
        await page.setViewportSize({ width: 1366, height: 768 });
        await check();
        await page.setViewportSize({ width: 390, height: 844 });
        await check();
      }
      await page.getByRole("button", { name: "展开楼层", exact: true }).click();
      await page.getByRole("button", { name: "重置视角", exact: true }).click();
      await check();
    });
  });
