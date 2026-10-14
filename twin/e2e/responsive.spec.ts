import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";

const sizes = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 2560, height: 1080 },
  { width: 900, height: 1200 },
  { width: 390, height: 844 },
];
for (const size of sizes) {
  test(`intrinsic overview and about ${size.width}x${size.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(size);
    await page.goto("/?source=mock");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".overview-grid")
          .evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
          ),
      )
      .toBe(size.width >= 1200 ? 3 : 1);
    const metrics = await page.locator(".dashboard").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        scale: getComputedStyle(el.parentElement!).transform,
      };
    });
    expect(metrics.width).toBe(
      await page.evaluate(() => document.body.clientWidth),
    );
    if (size.width > 1180) expect(metrics.height).toBe(size.height);
    else expect(metrics.height).toBeGreaterThanOrEqual(size.height);
    expect(metrics.scale).toBe("none");
    const assertReadable = async () => {
      const overflow = await page.locator("main").evaluate((el) => {
        const main = el.getBoundingClientRect();
        return [...el.querySelectorAll<HTMLElement>(".card, .overview-scene")]
          .filter((card) => card.getBoundingClientRect().width > 0)
          .map((card) => {
            const box = card.getBoundingClientRect();
            return {
              width: box.width,
              left: box.left >= main.left - 1,
              right: box.right <= main.right + 1,
              clipped:
                card.scrollHeight > card.clientHeight + 2 &&
                getComputedStyle(card).overflowY === "hidden",
            };
          });
      });
      expect(
        overflow.every((card) => card.left && card.right && !card.clipped),
        JSON.stringify(overflow),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    };
    await assertReadable();
    const canvas = (await page.locator(".twin-scene canvas").boundingBox())!;
    expect(canvas.width).toBeGreaterThan(200);
    expect(canvas.height).toBeGreaterThan(250);
    const controls = await page
      .locator(".responsive-dashboard button")
      .evaluateAll((elements) =>
        elements
          .filter(
            (el) =>
              el.getBoundingClientRect().width > 0 &&
              !(innerWidth > 1180 && el.closest(".timeline")) &&
              !el.hasAttribute("inert"),
          )
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [r.width, r.height];
          }),
      );
    expect(
      controls.every(
        ([width, height]) =>
          width >= (size.width <= 600 ? 35.9 : 43.9) &&
          height >= (size.width <= 600 ? 35.9 : 43.9),
      ),
    ).toBe(true);
    if (
      process.env.RESPONSIVE_CAPTURE &&
      ["1366x768", "1920x1080", "2560x1080", "390x844"].includes(
        `${size.width}x${size.height}`,
      )
    ) {
      await page.screenshot({
        path: info.outputPath(`responsive-${size.width}x${size.height}.png`),
      });
    }
    if (size.width === 390) {
      expect(
        await page
          .locator(".timeline-scroll")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(false);
      await setTimelineHour(page, 23);
      await expect
        .poll(() => page.locator(".timeline").getAttribute("data-time"))
        .toBe("23");
    }
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-page")).toBeVisible();
    await assertReadable();
    await expect(page.locator(".about-page")).toContainText(
      "由 Agnes Harness（AGH）协助开发",
    );
    await expect(page.locator(".about-page")).toContainText("CC BY-SA 4.0");
    if (size.width === 390)
      expect(
        await page
          .locator(".about-page")
          .evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
          ),
      ).toBe(1);
  });
}
