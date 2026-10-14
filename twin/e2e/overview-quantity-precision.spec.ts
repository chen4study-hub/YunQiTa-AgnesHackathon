import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { freezeTestHmr, assertShellScrolling } from "./shell-scroll-policy";
import { serveDataOverrides } from "./data-overrides-fixture";

for (const [width, height, dpr] of [
  [DESKTOP_125.width, DESKTOP_125.height, DESKTOP_125.dpr],
  [1366, 768, 1],
  [1920, 1080, 1],
  [390, 844, 1],
]) {
  test.describe(`overview quantity precision ${width}@${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("one decimal, atomic units, unchanged price precision", async ({
      page,
    }, info) => {
      await freezeTestHmr(page);
      await page.setViewportSize({ width, height });
      let active = false;
      await page.route("**/api/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== "/api/takeover/active") return route.abort();
        const hour = Number(url.searchParams.get("hour"));
        const start = Date.parse(`2026-10-12T${hour}:00:00+08:00`);
        return route.fulfill({
          json: {
            api_version: "1",
            takeover: active
              ? {
                  id: "precision-test",
                  version: 1,
                  date: "2026-10-12",
                  hour,
                  start_ms: start,
                  end_ms: start + 3600000,
                  hvac_setpoint_c: 26,
                  storage_mode: "charge",
                  storage_power_kw: 55,
                  operator_id: "值班员",
                  reason: "检查显示精度",
                  status: "active",
                  record_status: "active",
                }
              : null,
          },
        });
      });
      const checkGroups = async () => {
        const groups = await page
          .locator(
            ".overview-status-word, .scene-power-value, .overview-metric p .animated-number-text, .overview-quantity-value",
          )
          .evaluateAll((es) =>
            es
              .filter(
                (el) =>
                  /\d.*(?:kW|kWh|元|°C)/.test(el.textContent ?? "") &&
                  el.checkVisibility({ checkVisibilityCSS: true }),
              )
              .map((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                const rects = Array.from(range.getClientRects());
                const parent =
                  el.closest("[data-anchor]") ?? el.closest(".scene-legend") ?? el.closest(".card")!;
                const box = parent.getBoundingClientRect();
                const css = getComputedStyle(parent);
                return {
                  text: el.textContent,
                  lines: new Set(rects.map((r) => Math.round(r.top))).size,
                  fits: rects.every(
                    (r) =>
                      r.left >= box.left + parseFloat(css.paddingLeft) - 1 &&
                      r.right <= box.right - parseFloat(css.paddingRight) + 1,
                  ),
                };
              }),
          );
        expect(groups.length).toBeGreaterThanOrEqual(6);
        for (const group of groups) {
          expect(group.lines, group.text!).toBe(1);
          expect(group.fits, group.text!).toBe(true);
        }
      };
      for (const hour of [14, 23]) {
        await page.goto(`/?source=file&at=2026-10-12T${hour}:00`);
        await expect(page.locator(".overview-number")).toHaveCount(3);
        await expect(page.locator(".twin-scene")).toHaveAttribute(
          "data-scene-ready",
          "true",
        );
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
        const readings = await page
          .locator(".overview-number")
          .evaluateAll((es) =>
            es.map((el) => {
              const number = el
                .querySelector(".animated-number-text")!
                .getBoundingClientRect();
              const unit = el
                .querySelector(".type-unit")!
                .getBoundingClientRect();
              const box = el.getBoundingClientRect();
              return {
                text: el.textContent,
                sameLine: unit.top < number.bottom && unit.bottom > number.top,
                fits: unit.right <= box.right + 1,
                size: parseFloat(getComputedStyle(el).fontSize),
              };
            }),
          );
        for (const value of readings) {
          expect(value.text).toMatch(/^\d[\d,]*\.\d (kW|kWh|元)$/);
          expect(value.sameLine, value.text!).toBe(true);
          expect(value.fits, value.text!).toBe(true);
          expect(value.size).toBeGreaterThanOrEqual(24);
        }
        await expect(
          page.getByRole("region", { name: "今日预计电费", exact: true }),
        ).toContainText("1.20 元/kWh");
        const text = await page.locator(".overview-grid").innerText();
        for (const match of text.matchAll(
          /([-+]?\d[\d,]*(?:\.\d+)?)\s*(元\/kWh|kWh|kW|元|°C)/g,
        )) {
          expect(match[1], match[0]).toMatch(
            match[2] === "元/kWh" ? /\.\d{2}$/ : /\.\d$/,
          );
        }
        await checkGroups();
        await assertShellScrolling(page, `quantities ${width} at ${hour}`);
        await page
          .locator(".overview-left")
          .screenshot({ path: info.outputPath(`metrics-${hour}.png`) });
        await page
          .locator(".agent-verdict")
          .screenshot({ path: info.outputPath(`verdict-${hour}.png`) });
      }
      await page.goto('/?source=file&scenario=abstain&at=2026-10-01T10:00');
      await expect(page.locator('.twin-scene')).toHaveAttribute('data-scene-ready', 'true');
      await page.getByRole('button', { name: '展开楼层', exact: true }).click();
      await page.waitForTimeout(1800);
      await expect(page.locator('.scene-power-value')).toHaveCount(4);
      await checkGroups();
      await page.locator('.overview-scene').screenshot({ path: info.outputPath('holiday-expanded.png') });
      // Deliberately unformatted exported prose proves the UI normalizes integers and long decimals,
      // without editing replay bytes, source data, chart axes or IDs.
      const data = JSON.parse(
        readFileSync("public/replay/normal.json", "utf8"),
      );
      data.hours[14].agent.explanation =
        "空调设定 26 °C，储能 0 kW，电量 1,000 kWh，电费 21,145 元，电价 1.20 元/kWh。";
      data.hours[14].agent.actions = ["BA设定温度 26 °C", "EMS储能功率 0 kW"];
      await serveDataOverrides(page, {
        "normal.json": Buffer.from(JSON.stringify(data)),
      });
      await page.goto("/?source=file&at=2026-10-12T14:00");
      await expect(page.locator(".agent-verdict")).toContainText("26.0 °C");
      await expect(page.locator(".agent-verdict")).toContainText("0.0 kW");
      await expect(page.locator(".agent-verdict")).toContainText("1,000.0 kWh");
      await expect(page.locator(".agent-verdict")).toContainText("21,145.0 元");
      await expect(page.locator(".agent-verdict")).toContainText("1.20 元/kWh");
      await checkGroups();
      active = true;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator(".overview-takeover")).toContainText("26.0 °C");
      await expect(page.locator(".overview-takeover")).toContainText("55.0 kW");
      await checkGroups();
    });
  });
}
