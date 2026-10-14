import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
import { DESKTOP_125 } from "./viewport-profile";

for (const [width, height, dpr] of [
  [390, 844, 1],
  [DESKTOP_125.width, DESKTOP_125.height, DESKTOP_125.dpr],
  [1920, 1080, 1],
]) {
  test.describe(`value unit text ${width}`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: dpr });
    test("Overview and ValueCell keep NBSP text and unbroken units", async ({
      page,
    }, info) => {
      await freezeTestHmr(page);
      await page.route("**/api/**", (route) => route.abort());
      await page.goto("/?source=file&at=2026-10-12T14:00");
      await expect(page.locator(".overview-number")).toHaveCount(3);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (a) =>
                a.effect instanceof KeyframeEffect &&
                (a.effect.target as Element)?.closest(".page-enter"),
            )
            .map((a) => a.finished.catch(() => {})),
        );
      });
      await expect
        .poll(() =>
          page
            .locator(".overview-number .animated-number-text")
            .evaluateAll((es) =>
              es.every((e) => e.textContent === e.getAttribute("aria-label")),
            ),
        )
        .toBe(true);
      // The tariff/ops evidence loads asynchronously after the main data.
      await expect(page.locator(".overview-number").last()).toHaveText(
        /\d\u00a0元$/,
      );
      const check = async (selector: string) => {
        const rows = await page.locator(selector).evaluateAll((es) =>
          es.map((el) => {
            const unit = el.querySelector(".type-unit")!;
            const range = document.createRange();
            range.selectNodeContents(el);
            const rects = [...range.getClientRects()];
            const ur = unit.getBoundingClientRect(),
              box = el.getBoundingClientRect();
            const card = el
              .closest(".card, .value-cell")!
              .getBoundingClientRect();
            const number =
              el
                .querySelector(".animated-number-text")
                ?.getBoundingClientRect() ?? rects[0];
            const css = getComputedStyle(el);
            return {
              text: el.textContent,
              unit: unit.textContent?.slice(1),
              sameLine: ur.top < number.bottom && ur.bottom > number.top,
              nowrap: css.whiteSpace,
              gap: css.columnGap,
              fits: ur.right <= card.right && box.left >= card.left,
            };
          }),
        );
        for (const row of rows) {
          expect(row.text).toMatch(new RegExp(`\\d\\u00a0${row.unit}$`));
          expect(row.sameLine, row.text!).toBe(true);
          expect(row.nowrap).toBe("nowrap");
          expect(["normal", "0px"]).toContain(row.gap);
          expect(row.fits, row.text!).toBe(true);
        }
        return rows;
      };
      expect(await check(".overview-number")).toHaveLength(3);
      if (width === 1280 && process.env.NBSP_OVERVIEW_SCREENSHOT === "1") {
        await expect(page.locator('.twin-scene')).toHaveAttribute('data-scene-ready', 'true');
        await page.screenshot({
          path: info.outputPath("overview-1280-125.png"),
        });
      }
      // Render the real component in the same Vite document, inheriting public CSS.
      await page.evaluate(async () => {
        // Variable URLs leave native imports for Vite to transform on request.
        const reactUrl = "/node_modules/.vite/deps/react.js";
        const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
        const cellUrl = "/src/components/ValueCell.tsx";
        const { default: React } = await import(/* @vite-ignore */ reactUrl);
        const { default: ReactDOM } = await import(/* @vite-ignore */ domUrl);
        const { ValueCell } = await import(/* @vite-ignore */ cellUrl);
        const host = document.createElement("div");
        host.className = "responsive-dashboard";
        host.style.cssText =
          "position:fixed;inset:0;z-index:99999;background:#060a0f;padding:12px;overflow:auto";
        document.body.append(host);
        ReactDOM.createRoot(host).render(
          React.createElement(
            "div",
            null,
            ...[
              ["323.7", "kW"],
              ["13,875.9", "kWh"],
              ["21,145.3", "元"],
              ["-12.3", "°C"],
            ].map(([value, unit]) =>
              React.createElement(ValueCell, {
                key: unit,
                label: "数值",
                value,
                unit,
              }),
            ),
          ),
        );
      });
      await expect(page.locator(".value-cell strong")).toHaveCount(4);
      expect(await check(".value-cell strong")).toHaveLength(4);
    });
  });
}
