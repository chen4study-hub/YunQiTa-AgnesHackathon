import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { setTimelineHour } from "./timeline-helper";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
test("synced 1.5 file replay displays template wording and peak 14:00 standby", async ({
  page,
}) => {
  const normal = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
  const peak = JSON.parse(readFileSync("public/replay/peak.json", "utf8"));
  expect(normal.schema_version).toBe("1.5");
  expect(normal.hours[14].agent).toMatchObject({
    source: "llm",
    explanation_source: "template",
  });
  expect(peak.schema_version).toBe("1.5");
  expect(peak.hours[14].storage.power_kw).toBe(0);
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await expect(page.locator(".agent-verdict")).toContainText("LLM 决策");
  await page.goto("/?source=file&at=2026-07-23T14:00");
  await setTimelineHour(page, 14);
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "14");
  const storage = page.locator('.scene-labels > [data-anchor="storage"]');
  await expect(storage).toBeVisible();
  await expect(storage).toContainText("0.0 kW");
  await expect(storage).toContainText("待机 SOC 95.0%");
  await expect(storage).toHaveText(/^储能站\s+0\.0 kW待机 SOC 95\.0%$/);
  await expect(page.locator(".agent-verdict")).toContainText(
    "已自动下发 · 执行中",
  );
});
