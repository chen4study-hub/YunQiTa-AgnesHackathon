import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
test.use({ viewport: { width: 390, height: 844 } });
test("390x844 last About card stays completely above fixed footer; inset follows footer resize", async ({
  page,
}) => {
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator(".about-license")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const geometry = () =>
    page.evaluate(() => {
      const main = document.querySelector("main")!,
        footer = document.querySelector(".bottombar")!,
        card = document.querySelector(".about-license")!,
        f = footer.getBoundingClientRect(),
        c = card.getBoundingClientRect();
      const probe = document.createElement("div");
      probe.style.height = "env(safe-area-inset-bottom, 0px)";
      document.body.append(probe);
      const safe = probe.getBoundingClientRect().height;
      probe.remove();
      return {
        padding: parseFloat(getComputedStyle(main).paddingBottom),
        height: f.height,
        safe,
        top: c.top,
        bottom: c.bottom,
        footerTop: f.top,
        position: getComputedStyle(footer).position,
      };
    });
  const check = async () => {
    await expect
      .poll(async () => {
        const m = await geometry();
        return Math.abs(m.padding - m.height - m.safe) < 1;
      })
      .toBe(true);
    await page.locator(".about-license").scrollIntoViewIfNeeded();
    console.log("FOOTER_INSET", JSON.stringify(await geometry()));
    await expect
      .poll(async () => {
        const m = await geometry();
        return m.top >= 0 && m.bottom <= m.footerTop - 1;
      })
      .toBe(true);
    expect((await geometry()).position).toBe("fixed");
  };
  await check();
  const original = (await geometry()).height;
  // A larger footer (e.g. text sizing change) must update actual main clearance.
  await page
    .locator(".bottombar")
    .evaluate((el) => ((el as HTMLElement).style.minHeight = "140px"));
  await check();
  expect((await geometry()).height).toBeGreaterThan(original);
  await page
    .locator(".bottombar")
    .evaluate((el) => (el as HTMLElement).style.removeProperty("min-height"));
  await check();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("desktop main receives no fixed-footer padding", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?source=file&at=2026-10-12T14:00");
  expect(
    await page
      .locator("main")
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)),
  ).toBe(0);
});
