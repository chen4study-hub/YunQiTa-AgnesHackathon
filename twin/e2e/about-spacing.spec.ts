import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
const sizes = [
  DESKTOP_125,
  { width: 1366, height: 768 },
  { width: 1600, height: 830 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
];
for (const size of sizes)
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`About spacing and main-only scroll ${size.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize(size);
    await page.route("**/api/**", (r) => r.abort());
    page.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
    await page.goto("/?source=file&at=2026-10-12T18:31", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-page")).toBeVisible({ timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    const measure = await page.locator(".about-page").evaluate((root) => {
      const main = document.querySelector("main")!;
      const cards = [
        ...root.querySelectorAll<HTMLElement>(":scope > .card"),
      ].map((el) => {
        const css = getComputedStyle(el),
          rect = el.getBoundingClientRect();
        const body = el.querySelector(".about-card-body")!;
        const blocks = [...body.children].map((x) => x.getBoundingClientRect());
        return {
          name: el.className,
          padding: [
            css.paddingTop,
            css.paddingRight,
            css.paddingBottom,
            css.paddingLeft,
          ].map(parseFloat),
          inset:
            body.getBoundingClientRect().left -
            rect.left -
            parseFloat(css.borderLeftWidth),
          gaps: blocks.slice(1).map((r, i) => r.top - blocks[i].bottom),
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          blank:
            rect.bottom -
            blocks.at(-1)!.bottom -
            parseFloat(css.paddingBottom) -
            parseFloat(css.borderBottomWidth),
          overflow: css.overflowY,
          clipped: el.scrollHeight > el.clientHeight + 1,
        };
      });
      const rows = [
        ...root.querySelectorAll(".architecture-details > div"),
      ].map((el) => {
        const dt = el.querySelector("dt")!.getBoundingClientRect(),
          dd = el.querySelector("dd")!.getBoundingClientRect();
        return {
          top: el.getBoundingClientRect().top,
          dt: dt.left,
          dd: dd.left,
          dy: Math.abs(dt.top - dd.top),
        };
      });
      return {
        cards,
        rows,
        main: {
          height: main.clientHeight,
          scroll: main.scrollHeight,
          overflow: getComputedStyle(main).overflowY,
        },
        pageWidth: document.documentElement.scrollWidth,
        windowWidth: innerWidth,
      };
    });
    console.log(size.width, JSON.stringify(measure));

    for (const card of measure.cards) {
      expect(card.padding, card.name).toEqual(
        Array(4).fill(size.width >= 1600 ? 16 : 12),
      );
      expect(card.inset, card.name).toBeCloseTo(
        size.width >= 1600 ? 16 : 12,
        1,
      );
      expect(card.clipped, card.name).toBe(false);
      expect(["visible", "clip"]).toContain(card.overflow);
      card.gaps.forEach((gap, i) =>
        expect(gap, card.name).toBeCloseTo(
          card.name.includes("intro") ? (i === 1 ? 8 : 12) : i === 0 ? 8 : 12,
          1,
        ),
      );
      expect(Math.abs(card.blank), card.name).toBeLessThan(1);
    }
    expect(measure.pageWidth).toBeLessThanOrEqual(measure.windowWidth);
    const rhythm = await page.locator(".about-page").evaluate((root) => ({
      sectionGap:
        root.querySelector(".about-access")!.getBoundingClientRect().top -
        root.querySelector(".about-boundary")!.getBoundingClientRect().bottom,
      titleGap:
        root.querySelector(".about-access-notes")!.getBoundingClientRect().top -
        root.querySelector(".about-access h3")!.getBoundingClientRect().bottom,
      listGap: parseFloat(
        getComputedStyle(root.querySelector(".about-selling")!).rowGap,
      ),
      text: [...root.querySelectorAll("p,li,dd")].map((el) => {
        const s = getComputedStyle(el);
        return {
          size: parseFloat(s.fontSize),
          ratio: parseFloat(s.lineHeight) / parseFloat(s.fontSize),
        };
      }),
    }));
    expect(rhythm.sectionGap).toBeCloseTo(12, 1);
    expect(rhythm.titleGap).toBeCloseTo(8, 1);
    expect(rhythm.listGap).toBeGreaterThanOrEqual(4);
    expect(rhythm.listGap).toBeLessThanOrEqual(6);
    for (const text of rhythm.text) {
      expect(text.size).toBeGreaterThanOrEqual(12);
      expect(text.ratio).toBeGreaterThanOrEqual(1.5);
      expect(text.ratio).toBeLessThanOrEqual(1.6);
    }
    for (const row of measure.rows) expect(row.dy).toBeLessThan(1);
    if (size.width > 1180) {
      for (const index of [2, 3, 4])
        expect(measure.rows[index].dt).toBeCloseTo(
          measure.rows[index % 2].dt,
          1,
        );
      if (measure.main.scroll > measure.main.height) {
        expect(measure.main.overflow).toBe("auto");
        await page
          .locator("main")
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        expect(
          await page.locator("main").evaluate((el) => el.scrollTop),
        ).toBeGreaterThan(0);
      }
    }
    await page.locator("main").evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: info.outputPath("about.png"),
      fullPage: true,
      animations: "disabled",
      timeout: 10000,
    });
    if (size.width > 1180) {
      await page
        .locator("main")
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.screenshot({
        path: info.outputPath("about-bottom.png"),
        animations: "disabled",
        timeout: 10000,
      });
    }
  });
  });
