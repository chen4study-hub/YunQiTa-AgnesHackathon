import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { assertAlertsReachable } from "./alert-visibility";
import { freezeTestHmr } from "./shell-scroll-policy";
import { seekPageHour } from "./page-seek";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import { assertShellScrolling } from "./shell-scroll-policy";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function assertExportedAlertIds(
  page: Page,
  hour: number,
  dateText = "2026-10-12",
) {
  const calendar = JSON.parse(
    readFileSync(
      new URL("../public/replay/ops-calendar.json", import.meta.url),
      "utf8",
    ),
  );
  const date = calendar.days.find(
    (day: { date: string }) => day.date === dateText,
  );
  const ops = JSON.parse(
    readFileSync(
      new URL(`../public/replay/${date.scenario}.ops.json`, import.meta.url),
      "utf8",
    ),
  );
  const ids = [...ops.alerts, ...ops.work_orders]
    .filter(
      (record: { offset_ms: number }) => record.offset_ms <= hour * 3600000,
    )
    .map((record: { id: string }) => record.id)
    .sort();
  await expect
    .poll(async () =>
      page
        .locator(".energy-alert-table tbody tr[data-alert-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-alert-id")).sort(),
        ),
    )
    .toEqual(ids);
}

async function assertAlertHeaderAfterScroll(page: Page, context: string) {
  await assertAlertsReachable(page, context, false);
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
])
  for (const name of ["楼层与电梯", "能源与告警"]) {
    test(`${name} ${viewport.width}: scrollable layout, numeric hierarchy and lift geometry`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(viewport);
      await page.goto("/?source=file&at=2026-10-12T14:00", { waitUntil: "domcontentloaded" });
      await seekPageHour(page, 14);
      await page.getByRole("button", { name }).click();
      const root = page.locator(
        name === "楼层与电梯" ? ".floors-page" : ".energy-page",
      );
      await expect(root).toHaveAttribute("data-time", "14");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      await test.info().attach("layout-diagnostics", {
        body: JSON.stringify(
          await root.evaluate((e) =>
            Array.from(
              e.querySelectorAll(
                "section,table,tr,.energy-heading,.energy-alerts-summary,.floors-lift-scroll",
              ),
            ).map((n) => ({
              cls: n.className,
              tag: n.tagName,
              rect: n.getBoundingClientRect().toJSON(),
              css: {
                font: getComputedStyle(n).fontSize,
                line: getComputedStyle(n).lineHeight,
                padding: getComputedStyle(n).padding,
                minHeight: getComputedStyle(n).minHeight,
                rows: getComputedStyle(n).gridTemplateRows,
              },
            })),
          ),
        ),
        contentType: "application/json",
      });
      await test.info().attach("compact-before", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      const sizes = await root.evaluate((e) => ({
        width: e.clientWidth,
        scrollWidth: e.scrollWidth,
        height: e.clientHeight,
        scrollHeight: e.scrollHeight,
      }));
      expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.width + 1);
      // Main may grow vertically; the shared audit rejects 1–7px fake scrollbars
      // and main/document horizontal overflow, while allowing bounded table scrollers.
      await assertShellScrolling(page, `${name}/${viewport.width}`);
      if (name === "能源与告警")
        await assertAlertHeaderAfterScroll(
          page,
          `${name}/${viewport.width}/14`,
        );
      // Resolve the actual public tokens in-browser (including responsive clamp).
      const sharedType = await root.evaluate((e) => {
        const probe = document.createElement("span");
        e.append(probe);
        const token = (name: string) => {
          probe.style.fontSize = `var(${name})`;
          return parseFloat(getComputedStyle(probe).fontSize);
        };
        const expected = {
          title: token("--font-title"),
          note: token("--font-note"),
          medium: token("--font-value-md"),
          large: token("--font-value-lg"),
        };
        probe.remove();
        return {
          expected,
          title: parseFloat(getComputedStyle(e.querySelector("h2")!).fontSize),
          numbers: Array.from(
            e.querySelectorAll(
              ".floors-metrics b,.energy-cumulative b,.energy-ems-totals b,.energy-environment-metrics b",
            ),
          ).map((n) => parseFloat(getComputedStyle(n).fontSize)),
        };
      });
      expect(sharedType.title).toBeGreaterThanOrEqual(
        sharedType.expected.title - 0.01,
      );
      for (const size of sharedType.numbers)
        expect(size).toBeGreaterThanOrEqual(sharedType.expected.medium - 0.01);
      const chartHeights = await root
        .locator(
          name === "楼层与电梯"
            ? ".floors-temperature-chart"
            : ".energy-timeseries",
        )
        .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
      for (const height of chartHeights)
        expect(height).toBeGreaterThanOrEqual(
          name === "能源与告警" && viewport.width === 1366 ? 80 : 150,
        );
      // Visible content may extend into scrollable main; only actual card clipping fails.
      const clipped = await root.locator("section").evaluateAll((cards) =>
        cards
          .filter(
            (card) =>
              ["hidden", "clip"].includes(getComputedStyle(card).overflowY) &&
              card.scrollHeight > card.clientHeight + 1,
          )
          .map((card) => ({
            class: card.className,
            height: card.clientHeight,
            scrollHeight: card.scrollHeight,
          })),
      );
      expect(
        clipped,
        `${name}: card content must remain reachable while main scrolls`,
      ).toEqual([]);
      const typography = await root
        .locator(
          name === "楼层与电梯"
            ? ".floors-metrics b"
            : ".energy-donut-total b,.energy-cumulative b,.energy-environment-metrics b,.energy-ems-totals b",
        )
        .evaluateAll((es) =>
          es.map((b) => {
            const n = b.querySelector("span")!,
              u = b.querySelector("small")!;
            const ns = getComputedStyle(n),
              us = getComputedStyle(u);
            const nr = n.getBoundingClientRect(),
              ur = u.getBoundingClientRect();
            return {
              size: parseFloat(ns.fontSize),
              ratio: parseFloat(us.fontSize) / parseFloat(ns.fontSize),
              sameLine: ur.top < nr.bottom && ur.bottom > nr.top,
              width: b.clientWidth,
              scrollWidth: b.scrollWidth,
            };
          }),
        );
      for (const t of typography) {
        expect(t.size).toBeGreaterThanOrEqual(16);
        expect(t.ratio).toBeGreaterThanOrEqual(0.4);
        expect(t.ratio).toBeLessThanOrEqual(0.5);
        expect(t.sameLine).toBe(true);
        expect(t.scrollWidth).toBeLessThanOrEqual(t.width + 1);
      }
      if (name === "能源与告警") {
        expect(
          await root.locator(".energy-ems-totals small").allTextContents(),
        ).toEqual(["kWh", "kWh", "元"]);
        await expect(
          root
            .locator(".energy-ems-totals > div")
            .nth(2)
            .locator("span")
            .first(),
        ).toHaveText("本小时费用");
        const table = await root.locator(".energy-alert-table").boundingBox(),
          card = await root.locator(".energy-alerts").boundingBox();
        const region = await root.locator(".energy-table-scroll").boundingBox();
        expect(region!.x).toBeGreaterThanOrEqual(card!.x - 1);
        expect(region!.x + region!.width).toBeLessThanOrEqual(
          card!.x + card!.width + 1,
        );
        expect(
          await root
            .locator(".energy-alert-table")
            .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
        ).toBeCloseTo(sharedType.expected.note, 2);
        // Ops exports preserve real alert/work-order IDs; no padding to eight.
        await assertExportedAlertIds(page, 14);
      } else {
        await expect(root.locator(".floors-shaft-tick").first()).toHaveText(
          "40F",
        );
        const loadHeight = await root
          .locator(".floors-load-chart")
          .evaluate((e) => e.getBoundingClientRect().height);
        await expect(root.locator(".floors-load-chart")).toHaveAttribute(
          "data-bar-count",
          "40",
        );
        // All 40 bars need not fit one viewport: necessary chart/list vertical
        // scrolling is audited above, including the <8px false-scrollbar case.
        expect(loadHeight).toBeGreaterThan(0);
        expect(
          await root
            .locator(".floors-temperature-display")
            .first()
            .evaluate((e) => e.getBoundingClientRect().height),
        ).toBeGreaterThan(0);
        expect(
          await root
            .locator(".floors-lift-table")
            .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
        ).toBeCloseTo(sharedType.expected.note, 2);
        // Exercise geometry independent of animation clock: 1F, 20F, 40F.
        const geometry = await root
          .locator(".floors-lift-shaft")
          .first()
          .evaluate((shaft) => {
            const car = shaft.querySelector<HTMLElement>(".floors-lift-car")!;
            const sr = shaft.getBoundingClientRect();
            const results = [];
            for (const f of [1, 20, 40]) {
              const p = (f - 1) / 39;
              car.style.bottom = `calc(${p * 100}% - ${p} * var(--floors-car-height))`;
              const cr = car.getBoundingClientRect();
              results.push({
                f,
                top: cr.top - sr.top,
                bottom: sr.bottom - cr.bottom,
                left: cr.left - sr.left,
                right: sr.right - cr.right,
              });
            }
            return {
              height: sr.height,
              carHeight: car.getBoundingClientRect().height,
              results,
            };
          });
        // Responsive shaft height follows the desktop budget, not a fixed 120px.
        expect(geometry.height).toBeGreaterThan(geometry.carHeight);
        for (const r of geometry.results) {
          expect(r.top).toBeGreaterThanOrEqual(-1);
          expect(r.bottom).toBeGreaterThanOrEqual(-1);
          expect(r.left).toBeCloseTo(r.right, 1);
          if (r.f === 1) expect(r.bottom).toBeLessThan(1);
          if (r.f === 40) expect(r.top).toBeLessThan(1);
        }
      }
      for (const [scenario, date] of [
        ["normal", "2026-10-12"],
        ["abstain", "2026-10-01"],
      ]) {
        await page.goto(`/?source=file&at=${date}T14:00`);
        await page.getByRole("button", { name }).click();
        await expect(page.locator("main")).toHaveAttribute(
          "data-page",
          name === "楼层与电梯" ? "floors" : "energy",
        );
        await expect(page.locator("main")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await seekPageHour(page, 23);
        await expect(root).toHaveAttribute("data-time", "23");
        await page.waitForTimeout(450);
        await assertShellScrolling(
          page,
          `${name}/${viewport.width}/${scenario}`,
        );
        if (name === "能源与告警") {
          await assertAlertHeaderAfterScroll(
            page,
            `${name}/${viewport.width}/${scenario}/23`,
          );
          // Current Ops UI keeps all records in a scrolling table, not pagination.
          await assertExportedAlertIds(page, 23, date);
          const table = await root.locator(".energy-alert-table").boundingBox(),
            card = await root.locator(".energy-alerts").boundingBox();
          const region = await root
            .locator(".energy-table-scroll")
            .boundingBox();
          expect(region!.x).toBeGreaterThanOrEqual(card!.x - 1);
          expect(region!.x + region!.width).toBeLessThanOrEqual(
            card!.x + card!.width + 1,
          );
        }
      }
      await test.info().attach("compact-page", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
