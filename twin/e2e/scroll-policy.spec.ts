import { DESKTOP_125 } from "./viewport-profile";
import { freezeTestHmr } from "./shell-scroll-policy";
import { seekPageHour as setTimelineHour } from "./page-seek";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import {
  inspectShellScrolling,
  installScrollInspector,
} from "./shell-scroll-policy";

for (const size of [
  { width: 1366, height: 768, scale: 1 },
  { width: 1600, height: 830, scale: 1 },
  { width: 1920, height: 1080, scale: 1 },
  // A physical 1600x830 viewport at browser zoom 125% has 1280x664 CSS pixels.
  { ...DESKTOP_125, scale: DESKTOP_125.dpr },
]) {
  test.describe(`${size.width}x${size.height} / ${size.scale}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
    });
    test.describe(`viewport ${size.width}x${size.height}@${size.dpr ?? 1}`, () => {
      test.use({ deviceScaleFactor: size.dpr ?? 1 });
      test("overview and about scroll vertically only when needed while seeking and playing", async ({
        page,
      }) => {
        test.setTimeout(60000);
        await page.goto("/?source=file");
        await expect(page.locator(".twin-scene canvas")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator("main")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await page.evaluate(() => document.fonts.ready);
        await installScrollInspector(page);
        for (const name of ["总览", "关于"]) {
          await page.getByRole("button", { name, exact: false }).click();
          await expect(page.locator("main")).toHaveAttribute(
            "data-page",
            name === "总览"
              ? "overview"
              : name === "关于"
                ? "about"
                : name === "预测与风险"
                  ? "forecast"
                  : name === "Agent 决策"
                    ? "agent"
                    : name === "楼层与电梯"
                      ? "floors"
                      : "energy",
          );
          await page.waitForTimeout(400);
          for (const hour of [0, 10, 14, 23]) {
            await setTimelineHour(page, hour);
            await expect(page.locator(".timeline")).toHaveAttribute(
              "data-time",
              String(hour),
            );
            expect(
              await page.evaluate(inspectShellScrolling),
              `${name}/${hour}`,
            ).toEqual([]);
            const clipped = await page
              .locator("main .card")
              .evaluateAll((cards) =>
                cards
                  .filter(
                    (el) =>
                      el.clientHeight > 0 &&
                      (el.scrollHeight > el.clientHeight + 1 ||
                        el.scrollWidth > el.clientWidth + 1),
                  )
                  .map((el) => ({
                    class: el.className,
                    height: el.clientHeight,
                    scroll: el.scrollHeight,
                  })),
              );
            expect(clipped, `${name}/${hour} card content fits`).toEqual([]);
          }
          await setTimelineHour(page, 0);
          await expect(page.locator(".timeline")).toHaveAttribute(
            "data-time",
            "0",
          );
          await page
            .getByRole("button", { name: "▶ 播放", exact: true })
            .click();
          const frames = await page.evaluate(
            () =>
              new Promise<{ count: number; errors: string[] }>((resolve) => {
                const start = performance.now();
                const result = { count: 0, errors: [] as string[] };
                const sample = (now: number) => {
                  result.count++;
                  const errors = (
                    window as typeof window & {
                      __inspectShellScrolling: () => unknown[];
                    }
                  ).__inspectShellScrolling();
                  if (errors.length && result.errors.length < 10)
                    result.errors.push(JSON.stringify(errors));
                  if (now - start >= 6000) resolve(result);
                  else requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
              }),
          );
          await page
            .getByRole("button", { name: "Ⅱ 暂停", exact: true })
            .click();
          expect(frames.count).toBeGreaterThan(60);
          expect(frames.errors).toEqual([]);
        }
      });
    });
    test.describe(`viewport ${size.width}x${size.height}@${size.dpr ?? 1}`, () => {
      test.use({ deviceScaleFactor: size.dpr ?? 1 });
      test("six pages allow main and growing-list vertical scroll, never horizontal overflow", async ({
        page,
      }) => {
        test.setTimeout(90000);
        await page.goto("/?source=file");
        await expect(page.locator(".twin-scene canvas")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator("main")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await page.evaluate(() => document.fonts.ready);
        await installScrollInspector(page);
        // Empty auto-overflow cards must not scroll due to decorative corners.
        expect(
          await page.evaluate(() => {
            const card = document.createElement("section");
            card.className = "card";
            card.style.cssText =
              "position:fixed;width:120px;height:80px;overflow:auto;top:0;left:0";
            document.body.append(card);
            const overflow = {
              x: card.scrollWidth - card.clientWidth,
              y: card.scrollHeight - card.clientHeight,
            };
            card.remove();
            return overflow;
          }),
        ).toEqual({ x: 0, y: 0 });
        for (const name of [
          "总览",
          "预测与风险",
          "Agent 决策",
          "楼层与电梯",
          "能源与告警",
          "关于",
        ]) {
          await page.getByRole("button", { name, exact: false }).click();
          await expect(page.locator("main")).toHaveAttribute(
            "data-page",
            name === "总览"
              ? "overview"
              : name === "关于"
                ? "about"
                : name === "预测与风险"
                  ? "forecast"
                  : name === "Agent 决策"
                    ? "agent"
                    : name === "楼层与电梯"
                      ? "floors"
                      : "energy",
          );
          await page.waitForTimeout(400);
          for (const hour of [0, 10, 14, 23]) {
            await setTimelineHour(page, hour);
            await expect(page.locator(".timeline")).toHaveAttribute(
              "data-time",
              String(hour),
            );
            expect
              .soft(
                await page.evaluate(inspectShellScrolling),
                `${name}/${hour}`,
              )
              .toEqual([]);
          }
        }
        await page.getByRole("button", { name: "总览", exact: false }).click();
        await expect(page.locator(".scene-labels span")).toHaveCount(4);
        const labels = await page
          .locator(".scene-labels span")
          .evaluateAll((es) =>
            // Hidden labels have zero geometry; retain the same overflow/width
            // thresholds for every visible badge, and keep all four DOM entries.
            es
              .filter(
                (el) =>
                  el.checkVisibility({ checkVisibilityCSS: true }) &&
                  el.getBoundingClientRect().width > 0,
              )
              .map((el) => {
                const css = getComputedStyle(el);
                return {
                  background: css.backgroundColor,
                  whiteSpace: css.whiteSpace,
                  border: css.borderWidth,
                  padding:
                    parseFloat(css.paddingLeft) + parseFloat(css.paddingRight),
                  borderSides:
                    parseFloat(css.borderLeftWidth) +
                    parseFloat(css.borderRightWidth),
                  overflow: el.scrollWidth - el.clientWidth,
                  width: el.getBoundingClientRect().width,
                  textWidth: (() => {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    return range.getBoundingClientRect().width;
                  })(),
                };
              }),
          );
        for (const label of labels) {
          // Deliberate translucent badges protect label contrast over the tower.
          expect(label.background).toBe("rgba(7, 19, 27, 0.85)");
          expect(label.whiteSpace).toBe("normal");
          expect(label.border).toBe("1px");
          expect(label.overflow).toBeLessThanOrEqual(1);
          expect(label.textWidth).toBeLessThanOrEqual(
            label.width - label.padding - label.borderSides + 1,
          );
        }
        await test.info().attach("overview", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    });
  });
}
