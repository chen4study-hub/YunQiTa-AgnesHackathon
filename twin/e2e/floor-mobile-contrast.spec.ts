import { expect, test } from "@playwright/test";

function luminance(css: string) {
  const rgb = css
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number)
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const l = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l[0] + 0.05) / (l[1] + 0.05);
}
test("mobile shaft ticks and both stopped-car states have readable contrast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "楼层与电梯" }).click();
  await expect(page.locator(".floors-lift-shafts")).toBeVisible();
  await page.locator(".floors-lift-shafts").scrollIntoViewIfNeeded();
  const ticks = await page.locator(".floors-shaft-tick").evaluateAll((es) =>
    es.map((e) => {
      const style = getComputedStyle(e);
      return {
        fg: style.color,
        bg: style.backgroundColor,
        size: parseFloat(style.fontSize),
      };
    }),
  );
  expect(ticks).toHaveLength(30);
  for (const tick of ticks) {
    expect(contrast(tick.fg, tick.bg)).toBeGreaterThanOrEqual(4.5);
    expect(tick.size).toBeGreaterThanOrEqual(11);
  }
  // Exercise both CSS states deterministically on real page DOM. These fixtures
  // leave the production simulation, status palette and geometry untouched.
  const states = await page
    .locator(".floors-lift-car")
    .first()
    .evaluate((e) => {
      const car = e as HTMLElement;
      const original = car.dataset.status!;
      const originalStyle = car.getAttribute("style");
      const transitions = document.createElement("style");
      transitions.textContent =
        ".floors-lift-car,.floors-lift-car * { transition: none !important; }";
      document.head.append(transitions);
      const rows = ["doors", "idle"].map((status) => {
        car.dataset.status = status;
        car.style.color = "#9aa8b4";
        car.style.borderColor = "#9aa8b4";
        const style = getComputedStyle(car);
        return {
          status,
          bg: style.backgroundColor,
          border: style.borderTopColor,
          children: Array.from(car.children).map((child) => ({
            fg: getComputedStyle(child).color,
            size: parseFloat(getComputedStyle(child).fontSize),
          })),
        };
      });
      car.dataset.status = original;
      if (originalStyle === null) car.removeAttribute("style");
      else car.setAttribute("style", originalStyle);
      transitions.remove();
      return rows;
    });
  for (const state of states) {
    expect(state.border).toBe("rgb(154, 168, 180)");
    for (const child of state.children) {
      expect(contrast(child.fg, state.bg)).toBeGreaterThanOrEqual(4.5);
      expect(child.size).toBeGreaterThanOrEqual(11);
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(
    await page
      .locator(".floors-shaft-tick")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
});
