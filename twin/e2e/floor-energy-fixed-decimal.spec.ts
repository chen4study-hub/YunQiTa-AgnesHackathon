import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { formatNumber } from "../src/ui/numberFormat";
import { cumulativeUses } from "../src/pages/energy/data";
import { opsDay, isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";

for (const size of [
  DESKTOP_125,
  { width: 1366, height: 768, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`fixed decimal layout ${size.width} DPR ${size.dpr}`, () => {
    test.use({ deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("readings, full selector text and both page layouts", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await isolateOpsTest(page);
      await page.setViewportSize(size);
      const day = opsDay("2026-10-12");
      // Include an integral setpoint: the former formatter dropped its .0.
      for (const hour of [
        14,
        day.hours.findIndex((h) => Number.isInteger(h.hvac_setpoint_c)),
      ]) {
        expect(hour).toBeGreaterThanOrEqual(0);
        await page.goto(
          `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
          { waitUntil: "domcontentloaded" },
        );
        expect(await page.evaluate(() => devicePixelRatio)).toBe(size.dpr);
        await page.getByRole("button", { name: "楼层与电梯" }).click();
        await page
          .getByRole("combobox", { name: "选择楼层" })
          .selectOption("22");
        await page.evaluate(() => document.fonts.ready);
        await expect(
          page.locator(".floors-zone-setting > span:first-child"),
        ).toHaveText(
          Array(6).fill(
            `设定 ${formatNumber(day.hours[hour].hvac_setpoint_c, 1)} ℃`,
          ),
        );
        await expect(
          page.locator('.floors-metrics b[data-unit="kW"] .floors-number'),
        ).toHaveText(
          formatNumber(day.hours[hour].floors[21].floor_actual_kw, 1),
        );
        await expect(
          page.locator('.floors-metrics b[data-unit="℃"] .floors-number'),
        ).toHaveText(formatNumber(day.hours[hour].floors[21].mean_temp_c, 1));
        const selector = await page
          .getByRole("combobox", { name: "选择楼层" })
          .evaluate((el) => {
            const select = el as HTMLSelectElement,
              css = getComputedStyle(el);
            const canvas = document.createElement("canvas"),
              ctx = canvas.getContext("2d")!;
            ctx.font = css.font;
            const text = select.selectedOptions[0].textContent!.trim();
            return {
              text,
              textWidth: ctx.measureText(text).width,
              available:
                select.clientWidth -
                parseFloat(css.paddingLeft) -
                parseFloat(css.paddingRight) -
                24,
              fontSize: parseFloat(css.fontSize),
              labelSize: parseFloat(
                getComputedStyle(select.parentElement!).fontSize,
              ),
            };
          });
        expect(selector.text).toBe("22F 标准办公层");
        expect(selector.textWidth).toBeLessThanOrEqual(selector.available);
        expect(selector.fontSize).toBe(selector.labelSize);
        const floorFits = await page.locator(".floors-page").evaluate((root) =>
          Array.from(
            root.querySelectorAll(
              ".floors-zone-setting > span, .floors-metrics b",
            ),
          ).map((e) => {
            const range = document.createRange();
            range.selectNodeContents(e);
            const r = range.getBoundingClientRect(),
              cell = e
                .closest(".floors-zone, .floors-metrics > div")!
                .getBoundingClientRect();
            return Math.max(cell.left - r.left, r.right - cell.right, 0);
          }),
        );
        expect(Math.max(...floorFits)).toBeLessThanOrEqual(1);
        await assertShellScrolling(
          page,
          `fixed decimal floors ${size.width}/${hour}`,
        );
        if (hour === 14)
          await page.screenshot({
            path: info.outputPath(`floors-${size.width}-dpr${size.dpr}.png`),
          });
        await page.getByRole("button", { name: "能源与告警" }).click();
        await expect(
          page.locator(".energy-cumulative .energy-number"),
        ).toHaveText(
          cumulativeUses(day.hours[hour].energy.cumulative_start_kwh).map(
            (item) => formatNumber(item.energy, 1),
          ),
        );
        const text = await page.locator(".energy-cumulative").innerText();
        expect(text).toMatch(/\d\.\d/);
        await assertShellScrolling(
          page,
          `fixed decimal energy ${size.width}/${hour}`,
        );
        if (hour === 14)
          await page.screenshot({
            path: info.outputPath(`energy-${size.width}-dpr${size.dpr}.png`),
          });
      }
    });
  });
  });
}
