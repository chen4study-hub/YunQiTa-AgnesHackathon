import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";

import { seekPageHour } from "./page-seek";
import { powerRows } from "../src/pages/energy/PowerOverview";
import { energyNumber } from "../src/pages/energy/data";
import { opsDay, isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
const data = opsDay("2026-10-12");
for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  DESKTOP_125,
  { width: 390, height: 844 },
]) {
  test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test(`${viewport.width}: SOC arc, attached percent and signed Ops power bars`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await page.getByRole("button", { name: "能源与告警" }).click();
    for (const h of [0, 14, 23]) {
      await seekPageHour(page, h);
      await page.waitForTimeout(450);
      const percent = energyNumber(data.hours[h].storage.soc * 100, 1);
      await expect(
        page.getByRole("meter", { name: "储能 SOC" }),
      ).toHaveAttribute("aria-valuetext", `${percent}%`);
      await expect(page.locator(".energy-soc-reading b")).toHaveText(
        `${percent}%`,
      );
      const rows = powerRows(data, data.hours[h]);
      for (const row of rows) {
        const el = page.locator(`.energy-power-row[data-channel="${row.key}"]`);
        await expect(el.locator("b")).toHaveText(
          `${energyNumber(row.value, 1)} kW`,
        );
        const width = await el
          .locator(".energy-power-fill")
          .evaluate((e) => parseFloat((e as HTMLElement).style.width));
        expect(width).toBeCloseTo(row.width, 2);
      }
      const layout = await page.locator(".energy-ems-top").evaluate((e) => {
        const soc = e.querySelector(".energy-soc")!.getBoundingClientRect();
        const text = e
          .querySelector(".energy-soc-reading b")!
          .getBoundingClientRect();
        const rows = Array.from(e.querySelectorAll(".energy-power-row")).map(
          (row) => {
            const b = row.getBoundingClientRect();
            const track = row
              .querySelector(".energy-power-track")!
              .getBoundingClientRect();
            return {
              overflow: row.scrollWidth - row.clientWidth,
              width: track.width,
              height: track.height,
              inside: track.left >= b.left && track.right <= b.right,
            };
          },
        );
        const small = e.querySelector(".energy-soc-reading small")!,
          number = e.querySelector(".energy-soc-reading .energy-number")!;
        const svg = e.querySelector<SVGSVGElement>(".energy-soc-gauge")!;
        const inverse = svg.getScreenCTM()!.inverse();
        const reading = e.querySelector(".energy-soc-reading b")!;
        const original = number.textContent;
        const radii = [original!, "35.0", "100.0"].map((value) => {
          number.textContent = value;
          const b = reading.getBoundingClientRect();
          return Math.max(
            ...[b.left, b.right].flatMap((x) =>
              [b.top, b.bottom].map((y) => {
                const point = svg.createSVGPoint();
                point.x = x;
                point.y = y;
                const p = point.matrixTransform(inverse);
                return Math.hypot(p.x - 60, p.y - 54);
              }),
            ),
          );
        });
        number.textContent = original;
        return {
          radii,
          socWidth: soc.width,
          textWidth: text.width,
          gap:
            small.getBoundingClientRect().left -
            number.getBoundingClientRect().right,
          rows,
          emsOverflow:
            e.closest("section")!.scrollHeight -
            e.closest("section")!.clientHeight,
        };
      });
      expect
        .soft(
          Math.abs(layout.gap),
          `${viewport.width}/${h}: percent must touch digits`,
        )
        .toBeLessThanOrEqual(1);
      for (const radius of layout.radii)
        expect.soft(radius).toBeLessThanOrEqual(37.5);
      expect(layout.textWidth).toBeLessThan(layout.socWidth * 0.85);

      for (const row of layout.rows) {
        expect(row.width).toBeGreaterThan(row.height);
        expect(row.inside).toBe(true);
        expect(row.overflow).toBeLessThanOrEqual(1);
      }
      expect(layout.emsOverflow).toBeLessThanOrEqual(1);
    }
  });
  });
}
