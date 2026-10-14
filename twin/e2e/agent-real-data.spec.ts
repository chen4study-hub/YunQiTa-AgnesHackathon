import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
for (const viewport of [
  DESKTOP_125,
  { width: 390, height: 844 },
])
  test.describe(`real Agent ${viewport.width}`, () => {
    test.use({ viewport });
    test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test("midnight yesterday rows come from calendar-selected abstain main, keeping real IDs", async ({
      page,
    }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T00:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      if (viewport.width > 1180)
        await page
          .getByRole("tab", { name: "近期记录（6 小时）" })
          .first()
          .click();
      const rows = page.locator(".agent-record-card tbody tr");
      await expect(rows).toHaveCount(6);
      await expect(rows.nth(0)).toContainText("00:00");
      for (let i = 1; i <= 5; i++) {
        await expect(rows.nth(i)).toContainText(`昨日 ${24 - i}:00`);
        await expect(rows.nth(i)).toHaveAttribute(
          "data-record-scenario",
          "abstain",
        );
        await expect(rows.nth(i)).toHaveAttribute(
          "data-record-t",
          new RegExp(`2017-07-04T${24 - i}:00`),
        );
      }
      await expect(rows.first()).toHaveAttribute(
        "data-record-scenario",
        "normal",
      );
    });
  });
    test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test("unavailable yesterday calendar produces one real midnight row, not five fabricated rows", async ({
      page,
    }) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.route(
        (url) => url.pathname.endsWith("/replay/ops-calendar.json"),
        (r) => r.fulfill({ status: 503, body: "unavailable" }),
      );
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T00:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      if (viewport.width > 1180)
        await page
          .getByRole("tab", { name: "近期记录（6 小时）" })
          .first()
          .click();
      await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(1);
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "昨日",
      );
    });
  });
    test.describe(`viewport ${(viewport).width}x${(viewport).height}@${(viewport).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (viewport).dpr ?? 1 });
    test("candidate money, peak, selection and reason equal the 1.5 export; missing IDs are not synthesized", async ({
      page,
    }) => {
      const data = JSON.parse(
          readFileSync("public/replay/normal.json", "utf8"),
        ),
        a = data.hours[14].agent;
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      const rows = page.locator(".agent-comparison tbody tr");
      await expect(rows).toHaveCount(a.candidate_summaries.length);
      for (let i = 0; i < a.candidate_summaries.length; i++) {
        const s = a.candidate_summaries[i];
        await expect(rows.nth(i)).toHaveAttribute(
          "aria-selected",
          String(s.candidate_id === a.selected),
        );
        await expect(rows.nth(i)).toContainText(
          s.energy_cost_cny.toLocaleString("en-US", {
            maximumFractionDigits: 1,
          }),
        );
        await expect(rows.nth(i)).toContainText(
          s.upper_grid_peak_kw.toLocaleString("en-US", {
            maximumFractionDigits: 1,
          }),
        );
      }
      await expect(page.locator(".agent-reason-preview")).toContainText(
        a.explanation.split("。")[0],
      );
      await expect(page.locator(".agent-ticket")).not.toContainText("YQ-");
    });
  });
  });
