import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { currentUI4183 } from "./agent-local-ui-4183";
import { scheduleFixture } from "./agent-schedule-fixture";
for (const incomplete of [false, true])
  test(`two candidates with optional fields ${incomplete ? "missing" : "present"} render safely on 4183`, async ({
    page,
  }) => {
    await currentUI4183(page);
    const data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
    await page.route("**/api/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== "/api/schedule") return route.abort();
      const body = route.request().postDataJSON();
      expect(body?.start).toBeTruthy();
      const hour = data.hours.findIndex((h: any) => h.t === body.start),
        response: any = scheduleFixture(data, hour);
      response.candidates = response.candidates.slice(0, 2);
      response.selected = response.candidates[1].candidate_id;
      response.reason = "后端原文：选中保守方案。";
      if (incomplete) {
        delete response.receipt;
        delete response.work_orders;
        delete response.explanation_source;
        for (const c of response.candidates) {
          delete c.simulation;
          delete c.passed;
        }
      }
      return route.fulfill({ json: response });
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00");
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-root")).toHaveAttribute(
      "data-decision-source",
      "schedule",
    );
    await expect(page.locator(".agent-candidate-storage")).toHaveCount(2);
    await expect(page.locator(".agent-reason-preview")).toHaveText(
      "后端原文：选中保守方案。",
    );
    if (incomplete)
      await expect(page.locator(".agent-comparison")).toContainText("暂无数据");
    await expect(page.locator("[role=alert]")).toHaveCount(0);
  });
