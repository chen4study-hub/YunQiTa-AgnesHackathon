import { DESKTOP_125 } from "./viewport-profile";
test.use({ deviceScaleFactor: DESKTOP_125.dpr });
import { test, expect as baseExpect, type Page } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
import { serveOps } from "./ops-fixture";
const expect = baseExpect.configure({ timeout: 30000 });

test.use({
  timezoneId: "Asia/Shanghai",
  viewport: DESKTOP_125,
});
test.beforeEach(async ({ page }) => {
  test.setTimeout(150000);
  await freezeTestHmr(page);
  await serveOps(page);
  await page.route("**/api/**", (route) => route.abort());
  const real = new Date("2026-10-12T23:30:00+08:00");
  await page.clock.install({ time: real });
  await page.clock.pauseAt(real);
  await page.goto("/?source=file", { waitUntil: "domcontentloaded" });
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
    timeout: 30000,
  });
});
const text = (nextDay: boolean) =>
  `${nextDay ? "2026-10-13 周二" : "2026-10-12 周一"} 23:00:00`;
async function select23(page: Page) {
  const slider = page.getByRole("slider", { name: "24 小时时间轴" });
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("data-time", "23");
}
async function assertCommon(page: Page, nextDay: boolean) {
  const timestamp = text(nextDay),
    date = timestamp.slice(0, 13);
  await expect(page.getByLabel("当前本地时间", { exact: true })).toHaveText(
    timestamp,
  );
  await expect(page.getByLabel("当前本地日期", { exact: true })).toHaveText(
    date,
  );
  await expect(page.locator(".timeline")).toHaveAttribute(
    "aria-valuetext",
    /23:00:00$/,
  );
  await expect(page.locator(".timeline")).toHaveAttribute("data-time", "23");
  await expect(page.locator(".timeline-date-label")).toHaveText(
    nextDay ? "10-13" : "10-12",
  );
  await expect(
    page.getByRole("button", { name: "回到当前", exact: true }),
  ).toBeVisible();
}
async function assertPages(page: Page, nextDay: boolean) {
  const timestamp = text(nextDay),
    date = timestamp.slice(0, 13);
  const day = nextDay ? "2026-10-13" : "2026-10-12";
  await assertCommon(page, nextDay);
  await expect(
    page.locator(".overview-verdict-default > small").first(),
  ).toContainText("23:00:00");
  await page.getByRole("button", { name: "能源与告警", exact: false }).click();
  await expect(page.locator(".energy-page")).toHaveAttribute("data-date", date);
  await expect(page.locator(".energy-page")).toHaveAttribute(
    "data-time",
    "23",
    { timeout: 30000 },
  );
  await expect(page.locator(".energy-page")).toHaveAttribute(
    "data-ops-at-ms",
    String(Date.parse(`${day}T23:00:00+08:00`)),
  );
  await expect(page.locator(".energy-cursor-time")).toHaveAttribute(
    "datetime",
    `${day}T23:00:00`,
  );
  await expect(page.locator(".energy-cursor-time")).toContainText("23:00");
  await assertCommon(page, nextDay);
  for (const [name, root, origin] of [
    ["Agent 决策", ".agent-root", "data-origin"],
    ["预测与风险", ".forecast-root", "data-current-t"],
  ]) {
    await page.getByRole("button", { name, exact: false }).click();
    await expect(page.locator(root)).toHaveAttribute(
      "aria-description",
      timestamp,
      { timeout: 30000 },
    );
    await expect(page.locator(root)).toHaveAttribute("data-display-date", date);
    await expect(page.locator(root)).toHaveAttribute(origin, /T23:00/);
    await assertCommon(page, nextDay);
  }
  await page.getByRole("button", { name: "总览", exact: false }).click();
  await expect(
    page.locator(".overview-verdict-default > small").first(),
  ).toContainText("23:00:00");
  await assertCommon(page, nextDay);
}
test("selected 23:00 stays consistent across all pages while the wall clock advances", async ({
  page,
}) => {
  test.setTimeout(150000);
  await select23(page);
  await page.clock.fastForward(4000);
  await assertPages(page, false);
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(page.getByLabel("当前本地时间", { exact: true })).toHaveText(
    "2026-10-12 周一 23:30:04",
  );
  await expect(
    page.getByRole("button", { name: "回到当前", exact: true }),
  ).toHaveCount(0);
  await page.clock.fastForward(1000);
  await expect(page.getByLabel("当前本地时间", { exact: true })).toHaveText(
    "2026-10-12 周一 23:30:05",
  );
});
test("after playback crosses midnight and pauses, selected hours use the displayed day on every page", async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.clock.runFor(1216);
  await expect(page.locator(".timeline")).toHaveAttribute(
    "data-day-offset",
    "1",
  );
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  await expect(page.locator(".timeline")).toHaveAttribute(
    "data-playing",
    "false",
  );
  await expect(page.getByLabel("当前本地时间", { exact: true })).toContainText(
    "2026-10-13 周二",
  );
  await select23(page);
  await page.clock.fastForward(4000);
  await assertPages(page, true);
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(page.getByLabel("当前本地时间", { exact: true })).toContainText(
    "2026-10-12 周一 23:30:",
  );
  await expect(page.getByLabel("当前本地日期", { exact: true })).toHaveText(
    "2026-10-12 周一",
  );
  await expect(
    page.getByRole("button", { name: "回到当前", exact: true }),
  ).toHaveCount(0);
});
