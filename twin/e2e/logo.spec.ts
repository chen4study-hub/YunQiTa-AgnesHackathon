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
    test(`generated tower logo loads in header and About without overflow ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/?source=mock");
    await expect(page.locator(".twin-scene canvas")).toBeVisible();
    const svg = await (await page.request.get("/brand/yunqi-tower.svg")).text();
    expect(svg.match(/data-floor=/g)).toHaveLength(10);
    expect(svg.match(/data-face="side"/g)).toHaveLength(20);
    expect(svg).toContain('fill="#FF6A3D"');
    expect(svg).toContain("云栖塔</text>");
    expect(svg).toContain("YUNQI TOWER</text>");
    for (const name of ["总览", "关于"]) {
      await page.getByRole("button", { name, exact: false }).click();
      const logos = page.locator(
        name === "关于" ? ".top-logo,.about-logo" : ".top-logo",
      );
      const sizes = await logos.evaluateAll((images) =>
        images.map((image) => {
          const img = image as HTMLImageElement;
          const rect = img.getBoundingClientRect(),
            parent = img.parentElement!.getBoundingClientRect();
          return {
            loaded: img.complete && img.naturalWidth > 0,
            w: rect.width,
            h: rect.height,
            inBounds:
              rect.left >= parent.left - 1 && rect.right <= parent.right + 1,
          };
        }),
      );
      expect(
        sizes.every((s) => s.loaded && s.w > 0 && s.h > 0 && s.inBounds),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    console.log(
      `${size.width}: header/About logos loaded, contained; horizontal overflow=0`,
    );
  });
  });
}
