import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";

for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  DESKTOP_125, // physical 1600×830 at 125%
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`energy layout DPR ${size.dpr ?? 1} / ${size.width}`, () => {
    test.use({ deviceScaleFactor: size.dpr ?? 1 });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`energy metric value-unit pairs fit without false scrollbars ${size.width}`, async ({
      page,
    }) => {
      test.setTimeout(90000);
      await isolateOpsTest(page);
      await page.setViewportSize(size);
      for (const hour of [0, 14, 23]) {
        await page.goto(
          `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
          { waitUntil: "domcontentloaded" },
        );
        await page.getByRole("button", { name: "能源与告警" }).click();
        await expect(page.locator(".energy-ems-totals > div")).toHaveCount(3);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator(".energy-page").evaluate((root) => {
          const rows = Array.from(
            root.querySelectorAll<HTMLElement>(
              ".energy-ems-totals > div, .energy-cumulative > div, .energy-environment-metrics > div, .energy-soc-reading, .energy-power-row, .energy-use-legend li, .energy-donut-total",
            ),
          ).map((cell) => {
            const pair = cell.querySelector("b")!,
              number = pair.querySelector(".energy-number")!,
              unit = pair.querySelector("small");
            const range = document.createRange();
            range.selectNodeContents(pair);
            const value = range.getBoundingClientRect(),
              bounds = cell.getBoundingClientRect(),
              card = cell
                .closest(".energy-end-use, .energy-ems, .energy-environment")!
                .getBoundingClientRect();
            const n = number.getBoundingClientRect(),
              u = unit?.getBoundingClientRect();
            const css = getComputedStyle(cell);
            const left =
              bounds.left +
              parseFloat(css.borderLeftWidth) +
              parseFloat(css.paddingLeft);
            const right =
              bounds.right -
              parseFloat(css.borderRightWidth) -
              parseFloat(css.paddingRight);
            const probe = document.createElement("span");
            probe.style.fontSize = "var(--font-value-md)";
            probe.style.position = "absolute";
            probe.style.visibility = "hidden";
            cell.append(probe);
            const token = parseFloat(getComputedStyle(probe).fontSize);
            probe.remove();
            return {
              text: pair.textContent?.trim(),
              cellExcess: Math.max(left - value.left, value.right - right, 0),
              cardExcess: Math.max(
                card.left - value.left,
                value.right - card.right,
                0,
              ),
              overflow: cell.scrollWidth - cell.clientWidth,
              joined: !u || (u.top < n.bottom && u.bottom <= n.bottom + 2),
              metric: cell.matches(
                ".energy-ems-totals > div, .energy-cumulative > div, .energy-environment-metrics > div",
              ),
              size: parseFloat(getComputedStyle(pair).fontSize),
              token,
            };
          });
          const clipped = Array.from(
            root.querySelectorAll<HTMLElement>(
              ".energy-end-use, .energy-ems, .energy-environment",
            ),
          )
            .filter(
              (card) =>
                ["hidden", "clip"].includes(getComputedStyle(card).overflowY) &&
                card.scrollHeight - card.clientHeight > 1,
            )
            .map((card) => card.className);
          return {
            rows,
            clipped,
            horizontal: root.scrollWidth - root.clientWidth,
          };
        });
        console.log(
          size.width,
          hour,
          JSON.stringify({
            maxMetricExcess: Math.max(
              ...geometry.rows.map((row) => row.cellExcess),
            ),
            maxCardExcess: Math.max(
              ...geometry.rows.map((row) => row.cardExcess),
            ),
            horizontal: geometry.horizontal,
            clipped: geometry.clipped,
          }),
        );
        expect(geometry.horizontal).toBeLessThanOrEqual(1);
        expect(geometry.clipped).toEqual([]);
        for (const row of geometry.rows) {
          expect(row.cellExcess, row.text).toBeLessThanOrEqual(1);
          expect(row.cardExcess, row.text).toBeLessThanOrEqual(1);
          expect(row.overflow, row.text).toBeLessThanOrEqual(1);
          expect(row.joined, row.text).toBe(true);
          if (row.metric) expect(row.size, row.text).toBeCloseTo(row.token, 1);
        }
        await assertShellScrolling(
          page,
          `energy metrics ${size.width}/${hour}`,
        );
      }
    });
  });
  });
}
