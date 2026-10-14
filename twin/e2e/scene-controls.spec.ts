import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
  DESKTOP_125,
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`unified scene toolbar geometry and all seven controls ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/?source=mock");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    const toolbar = page.getByRole("toolbar", { name: "三维场景控件" });
    await expect(toolbar).toHaveCount(1);
    await expect(toolbar.locator("button")).toHaveCount(7);
    await expect(page.locator(".scene-aux-tools")).toHaveCount(0);
    const metrics = await toolbar.evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      width: el.clientWidth,
      scroll: el.scrollWidth,
      height: el.clientHeight,
      buttons: [...el.querySelectorAll("button")].map((b) => ({
        rect: b.getBoundingClientRect().toJSON(),
        font: parseFloat(getComputedStyle(b).fontSize),
        y: b.getBoundingClientRect().y,
        h: b.getBoundingClientRect().height,
        p: getComputedStyle(b).padding,
      })),
      overlap:
        el.getBoundingClientRect().bottom >
        document.querySelector(".twin-scene canvas")!.getBoundingClientRect()
          .top,
    }));
    console.log(`${size.width} toolbar`, JSON.stringify(metrics));

    expect(new Set(metrics.buttons.map((b) => b.h)).size).toBe(1);
    expect(new Set(metrics.buttons.map((b) => b.p)).size).toBe(1);
    expect(metrics.buttons.every((b) => b.h >= 36)).toBe(true);
    expect(metrics.overlap).toBe(false);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.width);
    for (const b of metrics.buttons) {
      expect(b.font).toBeGreaterThanOrEqual(14);
      expect(b.rect.left).toBeGreaterThanOrEqual(metrics.box.left);
      expect(b.rect.right).toBeLessThanOrEqual(metrics.box.right + 0.5);
      expect(b.rect.top).toBeGreaterThanOrEqual(metrics.box.top);
      expect(b.rect.bottom).toBeLessThanOrEqual(metrics.box.bottom + 0.5);
    }
    for (const button of await toolbar.locator("button").all()) {
      await expect(button).toBeVisible();
      await button.click({ trial: true });
    }
    const press = async (name: string) =>
      page.getByRole("button", { name, exact: true }).click();
    await press("自动旋转");
    await expect(
      page.getByRole("button", { name: "自动旋转", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await press("低画质");
    await expect(
      page.getByRole("button", { name: "低画质", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await press("真实外观");
    await expect(
      page.getByRole("button", { name: "真实外观", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await press("能耗着色");
    await expect(
      page.getByRole("button", { name: "能耗着色", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await press("透视");
    await expect(
      page.getByRole("button", { name: "透视", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await press("展开楼层");
    await expect(
      page.getByRole("button", { name: "展开楼层", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await press("重置视角");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  });
}
