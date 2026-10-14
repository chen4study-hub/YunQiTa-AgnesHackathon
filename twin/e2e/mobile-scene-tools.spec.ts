import { test, expect } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
test("mobile 3D toolbar shows all controls with wrapping without horizontal scrolling", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&at=2026-10-12T14:00");
  const toolbar = page.getByRole("toolbar", { name: "三维场景控件" });
  await expect(toolbar.getByRole("button")).toHaveCount(7);
  const geometry = await toolbar.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      scroll: el.scrollWidth,
      width: el.clientWidth,
      box: { left: box.left, right: box.right },
      buttons: Array.from(el.querySelectorAll("button")).map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left, right: r.right, y: r.top, text: b.textContent };
      }),
    };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  for (const b of geometry.buttons) {
    expect(b.x).toBeGreaterThanOrEqual(geometry.box.left);
    expect(b.right).toBeLessThanOrEqual(geometry.box.right + 0.5);
  }
  for (const button of await toolbar.getByRole("button").all()) {
    await expect(button).toBeVisible();
    await button.click({ trial: true });
    expect(
      await button.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(14);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const expand = toolbar.getByRole("button", { name: "展开楼层", exact: true });
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(expand).toHaveAttribute("aria-pressed", "true");
});
