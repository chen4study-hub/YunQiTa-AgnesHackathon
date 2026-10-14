import { expect, type Page } from "@playwright/test";
/** Use the public slider keyboard contract, never a hidden cell button. */
export async function setTimelineHour(page: Page, hour: number) {
  const slider = page.getByRole("slider", { name: "24 小时时间轴" });
  await slider.focus();
  await slider.press("Home");
  for (let i = 0; i < hour; i++) await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", String(hour));
}
