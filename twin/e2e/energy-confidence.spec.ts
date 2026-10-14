import { expect, test } from "@playwright/test";
import {
  opsDay,
  exportedAlerts,
  assertOpsAlerts,
  isolateOpsTest,
} from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
test("Ops work orders preserve exported content without invented confidence", async ({
  page,
}) => {
  const date = "2026-10-11",
    hour = 14,
    day = opsDay(date);
  await page.goto(`/?source=file&at=${date}T14:00`);
  await page.getByRole("button", { name: "能源与告警" }).click();
  await assertOpsAlerts(page, day, hour);
  for (const order of exportedAlerts(day, hour).filter((row) => row.agent)) {
    const row = page.locator(
      `.energy-alert-table tr[data-alert-id="${order.id}"]`,
    );
    await expect(row).toContainText(order.content);
    for (const check of order.suggested_checks)
      await expect(row).toContainText(check);
    if (!/置信度/.test(order.content + order.suggested_checks.join("")))
      await expect(row).not.toContainText("置信度");
    await expect(row).not.toContainText(/\d(?:\.\d+)?\s+%/);
  }
});
