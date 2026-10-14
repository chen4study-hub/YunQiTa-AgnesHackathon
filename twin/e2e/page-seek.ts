import { expect, type Page } from "@playwright/test";
/** Public shell now exposes one accessible slider instead of 24 buttons. */
export async function seekPageHour(page: Page, hour: number) {
  const slider = page.getByRole("slider", { name: "24 小时时间轴" });
  const box = await slider.boundingBox();
  if (!box) throw new Error("Timeline slider is not visible");
  await slider.click({ position: { x: (hour + 0.5) / 24 * box.width, y: box.height / 2 } });
  await expect(slider).toHaveAttribute("aria-valuenow", String(hour));
}
