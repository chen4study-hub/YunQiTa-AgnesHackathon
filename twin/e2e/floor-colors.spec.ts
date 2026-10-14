// Numeric unit spans must not be counted as top-level legend entries.
import { test, expect } from "@playwright/test";
import { floorColor, EQUIPMENT_COLOR } from "../src/ui/floorColors";
import { opsDay, OPS_DATES, isolateOpsTest } from "./ops-test-data";
import { opsFloorScale as dailyFloorScale } from "../src/pages/floors/metrics";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const width of [390, 1366, 1920])
  test(`scene and floor chart share daily office quantiles and grey equipment ${width}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : width === 1366 ? 768 : 1080,
    });
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    const snap = async () =>
      JSON.parse(
        (await page.locator(".twin-scene").getAttribute("data-scene")) ?? "{}",
      );
    await expect
      .poll(async () => Boolean((await snap()).floorColorScale))
      .toBe(true);
    const scale = (await snap()).floorColorScale;
    for (const hour of [0, 10, 14, 23]) {
      await page.goto(
        `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
      );
      await expect
        .poll(async () => (await snap()).floorColorScale)
        .toEqual(scale);
    }
    const legend = await page.locator(".scene-legend").innerText();
    for (const p of [10, 50, 90]) expect(legend).toContain(`p${p}`);
    expect(
      await page
        .locator(".scene-legend i")
        .evaluateAll((es) =>
          es.slice(0, 3).map((el) => getComputedStyle(el).backgroundColor),
        ),
    ).toEqual(["rgb(47, 191, 143)", "rgb(229, 190, 106)", "rgb(242, 146, 82)"]);
    await page
      .getByRole("button", { name: "楼层与电梯", exact: false })
      .click();
    const data = opsDay("2026-10-12");
    const expected = dailyFloorScale(data);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await expect.poll(async () => (await snap()).opsAvailable).toBe(true);
    expect.soft((await snap()).floorColorScale).toEqual(expected);
    const overviewLegend = (
      await page.locator(".scene-legend > span").allTextContents()
    ).slice(0, 4);
    await page
      .getByRole("button", { name: "楼层与电梯", exact: false })
      .click();
    await expect(page.locator(".floors-load-legend > span")).toHaveCount(4);
    expect
      .soft(await page.locator(".floors-load-legend > span").allTextContents())
      .toEqual(overviewLegend.map((text) => text.trim()));
    await expect(page.locator(".floors-load-legend i")).toHaveCount(4);
    expect(
      await page
        .locator(".floors-load-legend i")
        .evaluateAll((es) =>
          es.map((el) => getComputedStyle(el).backgroundColor),
        ),
    ).toEqual([
      "rgb(47, 191, 143)",
      "rgb(229, 190, 106)",
      "rgb(242, 146, 82)",
      "rgb(133, 151, 163)",
    ]);
    for (const hour of [0, 10, 14, 23]) {
      await page.goto(
        `/?source=file&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
      );
      await expect(page.locator(".bottombar")).toBeVisible();
      await page.getByRole("button", { name: "楼层与电梯" }).click();
      await expect
        .poll(async () => {
          const actual = JSON.parse(
            (await page
              .locator(".floors-load-chart")
              .getAttribute("data-color-scale")) ?? "{}",
          );
          return Math.max(
            ...(["p10", "p50", "p90"] as const).map((key) =>
              Math.abs(actual[key] - expected[key]),
            ),
          );
        })
        .toBeLessThan(1e-6);
      await page.waitForTimeout(450);
      const colors = data.hours[hour].floors.map((row) =>
        floorColor(row.floor_actual_kw, expected, row.use),
      );
      if (hour === 14) {
        const officeColors = colors.filter(
          (_: string, i: number) => data.hours[hour].floors[i].use === "office",
        );
        expect(new Set(officeColors).size).toBeGreaterThan(15);
        const channels = officeColors.map((hex: string) => [
          parseInt(hex.slice(1, 3), 16),
          parseInt(hex.slice(3, 5), 16),
        ]);
        expect(channels.some(([r, g]: number[]) => g > r)).toBe(true);
        expect(channels.some(([r, g]: number[]) => r > g)).toBe(true);
      }
      const drawn = await page
        .locator(".floors-load-chart canvas")
        .first()
        .evaluate(
          (el, colors) => {
            const canvas = el as HTMLCanvasElement;
            const pixels = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            const present = new Set<number>();
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i + 3] === 255)
                present.add(
                  (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2],
                );
            return colors.filter((color) =>
              present.has(parseInt(color.slice(1), 16)),
            );
          },
          [...new Set<string>(colors)],
        );
      expect(drawn).toContain(EQUIPMENT_COLOR);
      expect(drawn.length).toBeGreaterThanOrEqual(
        Math.min(new Set(colors).size, 5),
      );
    }
    await expect(page.locator(".floors-load-chart")).toHaveAttribute(
      "aria-description",
      /办公层8–20点负荷/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const layout = await page.locator(".floors-list-card").evaluate((card) => {
      const chart = card
        .querySelector(".floors-load-chart")!
        .getBoundingClientRect();
      const legend = card
        .querySelector(".floors-load-legend")!
        .getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      return {
        overflow: card.scrollHeight - card.clientHeight,
        below: legend.top >= chart.bottom,
        inside: legend.bottom <= bounds.bottom,
        horizontal: card.scrollWidth - card.clientWidth,
        labelsFit: Array.from(
          card.querySelectorAll(".floors-load-legend > span"),
        ).every((el) => el.scrollWidth <= el.clientWidth + 1),
      };
    });
    expect(layout.labelsFit).toBe(true);
    expect(layout.below).toBe(true);
    expect(layout.inside).toBe(true);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.horizontal).toBeLessThanOrEqual(1);
    await assertShellScrolling(page, "Ops floor colors");
  });

for (const scenario of ["normal", "peak", "abstain"] as const) {
  test(`1366: shared daily scale and legend update on ${scenario}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const date = OPS_DATES[scenario];
    await page.goto(`/?source=file&at=${date}T14:00`);
    const data = opsDay(date);
    const scale = dailyFloorScale(data);
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.locator(".twin-scene").getAttribute("data-scene")) ??
              "{}",
          ).opsAvailable,
      )
      .toBe(true);
    expect
      .soft(
        JSON.parse(
          (await page.locator(".twin-scene").getAttribute("data-scene")) ??
            "{}",
        ).floorColorScale,
      )
      .toEqual(scale);
    console.log(
      "OPS_SCALE",
      scenario,
      JSON.stringify({
        expected: scale,
        scene: JSON.parse(
          (await page.locator(".twin-scene").getAttribute("data-scene")) ??
            "{}",
        ).floorColorScale,
      }),
    );
    const legend = (await page.locator(".scene-legend > span").allTextContents())
      .slice(0, 4)
      .map((s) => s.trim());
    await page
      .getByRole("button", { name: "楼层与电梯", exact: false })
      .click();
    for (const hour of [0, 14, 23]) {
      await page.goto(
        `/?source=file&at=${date}T${String(hour).padStart(2, "0")}:00`,
      );
      await expect(page.locator(".bottombar")).toBeVisible();
      await page.getByRole("button", { name: "楼层与电梯" }).click();
      await expect(page.locator(".floors-load-chart")).toHaveAttribute(
        "data-color-scale",
        JSON.stringify(scale),
      );
      expect
        .soft(
          await page.locator(".floors-load-legend > span").allTextContents(),
        )
        .toEqual(legend);
    }
  });
}
