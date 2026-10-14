import { opsDay, OPS_DATES, isolateOpsTest } from "./ops-test-data";
import { opsFloorScale } from "../src/data/ops/floorColors";
import { test, expect } from "@playwright/test";
import { setTimelineHour } from "./timeline-helper";
import { floorColor, EQUIPMENT_COLOR } from "../src/ui/floorColors";
for (const width of [390, 1366, 1920])
  test(`overview office-only daily scale and equipment-grey targets ${width}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await isolateOpsTest(page);
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : width === 1366 ? 768 : 1080,
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    const snapshot = async () =>
      JSON.parse(
        (await page.locator(".twin-scene").getAttribute("data-scene")) || "{}",
      );
    for (const scenario of ["normal", "peak", "abstain"] as const) {
      const day = opsDay(OPS_DATES[scenario as keyof typeof OPS_DATES]);
      const data = await (
        await page.request.get(`/replay/${scenario}.json`)
      ).json();
      const scale = opsFloorScale(day);
      await page.goto(
        `/?source=file&scenario=${scenario}&at=${OPS_DATES[scenario]}T14:00`,
      );
      await expect
        .poll(async () => (await snapshot()).floorColorScale)
        .toEqual(scale);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      for (const hour of [3, 14, 23]) {
        await setTimelineHour(page, hour);
        await expect(page.locator(".timeline")).toHaveAttribute(
          "data-time",
          String(hour),
        );
        const h = data.hours[hour];
        const expected = day.hours[hour].floors.map((f) =>
          f.use === "equipment"
            ? EQUIPMENT_COLOR
            : h.abstain
              ? "#E66B78"
              : floorColor(f.floor_actual_kw, scale, f.use),
        );
        await expect
          .poll(async () => ({
            scale: (await snapshot()).floorColorScale,
            colors: (await snapshot()).floorTargetColors,
          }))
          .toEqual({
            scale,
            colors: expected.map((c: string) => c.slice(1).toLowerCase()),
          });
      }
      for (const [index, p] of [10, 50, 90].entries())
        await expect(page.locator(".scene-legend")).toContainText(
          `${[scale.p10, scale.p50, scale.p90][index].toFixed(1)} kW · p${p}`,
        );
      await page
        .getByRole("button", { name: "楼层与电梯", exact: false })
        .click();
      await expect
        .poll(async () =>
          JSON.parse(
            (await page
              .locator(".floors-load-chart")
              .getAttribute("data-color-scale")) || "{}",
          ),
        )
        .toEqual(scale);
      await page.getByRole("button", { name: "总览", exact: false }).click();
      await expect(page.locator(".scene-legend")).toContainText("设备层");
      await expect(page.locator(".scene-legend")).toHaveAttribute(
        "aria-label",
        /办公层 08:00–20:00 固定分位数/,
      );
      expect(
        await page
          .locator(".scene-legend span")
          .filter({ hasText: "设备层" })
          .locator("i")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
      ).toBe("rgb(133, 151, 163)");
      await page.getByRole("button", { name: "真实外观", exact: true }).click();
      await expect
        .poll(async () => (await snapshot()).floorTargetColors?.[1])
        .toBe(EQUIPMENT_COLOR.slice(1).toLowerCase());
      await page.getByRole("button", { name: "能耗着色", exact: true }).click();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
