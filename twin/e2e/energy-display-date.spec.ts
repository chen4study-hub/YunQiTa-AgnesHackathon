import { DESKTOP_125 } from "./viewport-profile";
test.use({ deviceScaleFactor: DESKTOP_125.dpr });
import { expect, test } from "@playwright/test";
import { formatDisplayDate } from "../src/config/presentation";
import {
  opsDay,
  OPS_DATES,
  exportedAlerts,
  assertOpsAlerts,
  isolateOpsTest,
} from "./ops-test-data";
import { opsDateTime, opsTimeLabel } from "../src/pages/energy/time";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
test("Ops alert IDs remain backend IDs; row event times and heading use the selected calendar day", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_125);
  for (const date of Object.values(OPS_DATES)) {
    const day = opsDay(date),
      at = day.day_start_ms + 14 * 3600000;
    const display = formatDisplayDate(at);
    await page.goto(`/?source=file&at=${date}T14:00`);
    await page.getByRole("button", { name: "能源与告警" }).click();
    await assertOpsAlerts(page, day, 14);
    await expect(page.locator(".energy-page")).toHaveAttribute(
      "data-date",
      display,
    );
    const heading = page.locator(".energy-alerts .energy-heading time");
    await expect(heading).toHaveText(`${display} · 14:00`);
    await expect(heading).toHaveAttribute("datetime", `${date}T14:00:00`);
    await expect(page.getByLabel("当前本地时间", { exact: true })).toHaveText(
      `${display} 14:00:00`,
    );
    for (const record of exportedAlerts(day, 14)) {
      const time = page.locator(`tr[data-alert-id="${record.id}"] time`);
      const event = day.day_start_ms + record.offset_ms;
      await expect(time).toHaveAttribute("datetime", opsDateTime(event));
      await expect(time).toHaveText(opsTimeLabel(event, at));
      // IDs do not gain a fabricated current-date prefix.
      if (record.agent)
        await expect(
          page.locator(`tr[data-alert-id="${record.id}"] .energy-order-id`),
        ).toHaveText(record.id);
    }
  }
});
