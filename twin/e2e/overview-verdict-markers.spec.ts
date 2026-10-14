import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const width of [390, 1366, DESKTOP_125.width])
  test.describe(`viewport ${width}`, () => {
    test.use({deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1});
  test(
    "live verdict markers remain in the content box " + width,
    async ({ page }) => {
      test.setTimeout(90000);
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : width === DESKTOP_125.width ? DESKTOP_125.height : 768,
      });
      const data = JSON.parse(
          readFileSync("public/replay/normal.json", "utf8"),
        ),
        hour = data.hours[14];
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/schedule")) return route.abort();
        const command = {
          timestamp: hour.t,
          hvac_setpoint_c: 25.5,
          battery_kw: 0,
          action: "execute",
        };
        return route.fulfill({
          json: {
            building_id: data.meta.building_id,
            source: "rule",
            explanation_source: "template",
            selected: "rule_hold",
            plan: [command],
            candidates: [
              {
                candidate_id: "rule_hold",
                name: "保持设定",
                passed: true,
                plan: [command],
              },
            ],
            reason: "当前小时保持设定，储能待机。",
            receipt: {
              count: 1,
              transport: "log_only",
              device_connected: false,
            },
          },
        });
      });
      await page.goto("/?source=file&at=2026-10-12T14:00");
      await expect(page.locator(".verdict-body")).toHaveAttribute(
        "data-decision-source",
        "schedule",
        {timeout:20000},
      );
      await expect(page.locator(".overview-selected-plan")).toContainText(
        "保持设定",
      );
      await expect(page.locator(".overview-storage-power")).toContainText(
        "待机",
      );
      const result = await page.locator(".agent-verdict").evaluate((card) => {
        const c = getComputedStyle(card),
          r = card.getBoundingClientRect(),
          left = r.left + parseFloat(c.paddingLeft),
          right = r.right - parseFloat(c.paddingRight);
        const ul = card.querySelector("ul")!,
          style = getComputedStyle(ul);
        return {
          position: style.listStylePosition,
          overflow: card.scrollHeight - card.clientHeight,
          items: [...ul.children].map((li) => {
            const b = li.getBoundingClientRect();
            return { left: b.left >= left - 1, right: b.right <= right + 1 };
          }),
        };
      });
      expect(result.position).toBe("inside");
      expect(result.overflow).toBeLessThanOrEqual(1);
      expect(result.items).toEqual([
        { left: true, right: true },
        { left: true, right: true },
      ]);
    },
  );

  });
