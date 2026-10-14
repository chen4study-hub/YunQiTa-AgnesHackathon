import { expect, test } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}: external shaft ticks never overlap cars at any stop`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    await expect(page.locator(".floors-lift-shaft")).toHaveCount(6);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".floors-shaft-tick:visible")).toHaveCount(
      viewport.width === 1366 ? 5 : 30,
    );
    const checks = await page.locator(".floors-lift-shaft").evaluateAll((es) =>
      es.flatMap((shaft) => {
        const car = shaft.querySelector<HTMLElement>(".floors-lift-car")!;
        const original = car.getAttribute("style"),
          status = car.dataset.status;
        const column = shaft
          .closest(".floors-lift-shafts")!
          .getBoundingClientRect();
        const rows = [1, 10, 20, 30, 40].map((floor) => {
          const p = (floor - 1) / 39;
          car.style.bottom = `calc(${p * 100}% - ${p} * var(--floors-car-height))`;
          car.dataset.status = "doors";
          const c = car.getBoundingClientRect(),
            s = shaft.getBoundingClientRect();
          return {
            floor,
            carWidth: c.width,
            shaftWidth: s.width,
            textOverflow: car.scrollWidth - car.clientWidth,
            centered: Math.abs(c.left - s.left - (s.right - c.right)),
            ticks: Array.from(shaft.querySelectorAll(".floors-shaft-tick"))
              .filter((tick) => getComputedStyle(tick).display !== "none")
              .map((tick) => {
                const t = tick.getBoundingClientRect();
                return {
                  text: tick.textContent,
                  gap: c.left - t.right,
                  left: t.left - column.left,
                  right: column.right - t.right,
                };
              }),
          };
        });
        if (original === null) car.removeAttribute("style");
        else car.setAttribute("style", original);
        car.dataset.status = status;
        return rows;
      }),
    );
    for (const row of checks) {
      expect(row.centered).toBeLessThanOrEqual(1);
      expect(row.carWidth).toBeGreaterThanOrEqual(
        viewport.width === 1366 ? 28 : 10,
      );
      if (viewport.width === 1366)
        expect(row.shaftWidth).toBeGreaterThanOrEqual(34);
      expect(row.textOverflow).toBeLessThanOrEqual(1);
      for (const tick of row.ticks) {
        expect(tick.gap, tick.text ?? "").toBeGreaterThanOrEqual(4);
        expect(tick.left).toBeGreaterThanOrEqual(0);
        expect(tick.right).toBeGreaterThanOrEqual(0);
      }
    }
    if (viewport.width === 1366) {
      await info.attach("shaft-geometry.json", {
        body: JSON.stringify(checks),
        contentType: "application/json",
      });
      await info.attach("floor-page-1366.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    const widths = checks.map((row) => row.shaftWidth);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(
      await page
        .locator(".floors-page")
        .evaluate((e) => e.scrollWidth - e.clientWidth),
    ).toBeLessThanOrEqual(1);
  });
}
