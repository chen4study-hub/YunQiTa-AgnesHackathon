import { test, expect } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });
test("selection survives four real seconds and pins 3D; return resumes the real clock", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?source=file");
  const timeline = page.getByRole("slider", { name: "24 小时时间轴" });
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const selected = await page.evaluate(() => (new Date().getHours() + 6) % 24);
  await timeline.focus();
  await timeline.press("Home");
  for (let i = 0; i < selected; i++) await timeline.press("ArrowRight");
  const clock = page.getByLabel("当前本地时间");
  const before = await clock.innerText();
  await page.waitForTimeout(4100);
  await expect(timeline).toHaveAttribute("data-time", String(selected));
  await expect(clock).toHaveText(before);
  expect(before.slice(-8)).toBe(`${String(selected).padStart(2, "0")}:00:00`);
  await expect
    .poll(() =>
      page
        .locator(".twin-scene")
        .evaluate(
          (el) => JSON.parse(el.getAttribute("data-scene")!).visualHour,
        ),
    )
    .toBe(selected);
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  const realHour = await page.evaluate(() => new Date().getHours());
  await expect(timeline).toHaveAttribute("data-time", String(realHour));
  const returned = await clock.innerText();
  await expect(clock).not.toHaveText(returned);
});
test("pinned date survives midnight and selection after playback uses the next-day cells", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-12T23:59:58+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T23:59:58+08:00"));
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/?source=file");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const timeline = page.getByRole("slider", { name: "24 小时时间轴" });
  const clock = page.getByLabel("当前本地时间");
  const selectNine = async () => {
    await timeline.focus();
    await timeline.press("Home");
    for (let i = 0; i < 9; i++) await timeline.press("ArrowRight");
  };
  await selectNine();
  await expect(clock).toHaveText("2026-10-12 周一 09:00:00");
  await page.clock.fastForward(4000);
  await expect(clock).toHaveText("2026-10-12 周一 09:00:00");
  await expect(page.locator(".timeline-date-label")).toHaveText("10-12");
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(clock).toHaveText("2026-10-13 周二 00:00:02");
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.clock.fastForward(24016);
  await expect(clock).toHaveText("2026-10-14 周三 00:00:02");
  await expect(
    page.getByRole("button", { name: "↺ 重置", exact: true }),
  ).toBeVisible();
  await selectNine();
  await expect(clock).toHaveText("2026-10-14 周三 09:00:00");
  await expect(timeline).toHaveAttribute("data-time", "9");
  await expect(page.locator(".timeline-date-label")).toHaveText("10-14");
  await page.clock.fastForward(4000);
  await expect(clock).toHaveText("2026-10-14 周三 09:00:00");
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(clock).toContainText("2026-10-13 周二 00:00:");
  const returned = await clock.innerText();
  await page.clock.fastForward(1000);
  await expect(clock).not.toHaveText(returned);
});
for (const width of [320, 390, 1366, 1920]) {
  test(`selected time holds, return follows real clock and fits footer ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1080 });
    await page.clock.install({ time: new Date("2026-10-12T13:59:58+08:00") });
    await page.clock.pauseAt(new Date("2026-10-12T13:59:58+08:00"));
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/?source=file");
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    const timeline = page.getByRole("slider", { name: "24 小时时间轴" });
    const clock = page.getByLabel("当前本地时间");
    const back = page.getByRole("button", { name: "回到当前", exact: true });
    await expect(back).toHaveCount(0);
    // Hit the actual fifth-hour block, including touch-sized mobile cells.
    const box = (await timeline.boundingBox())!;
    await page.mouse.click(
      box.x + (box.width * 5.5) / 24,
      box.y + box.height / 2,
    );
    await expect(timeline).toHaveAttribute("data-time", "5");
    await expect(back).toBeVisible();
    await expect(clock).toHaveText("2026-10-12 周一 05:00:00");
    await expect(timeline).toHaveAttribute(
      "aria-valuetext",
      "2026-10-12 周一 05:00:00",
    );
    // Advance the running browser clock beyond three seconds and across an hour boundary.
    await page.clock.fastForward(4000);
    await expect(clock).toHaveText("2026-10-12 周一 05:00:00");
    await expect(timeline).toHaveAttribute("data-time", "5");
    const controls = await page
      .locator("footer button, footer .clock")
      .evaluateAll((elements) =>
        elements
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          }),
      );
    for (const r of controls) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(width);
    }
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i],
          b = controls[j];
        expect(
          a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top,
        ).toBe(true);
      }
    expect(
      await page
        .locator("footer")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await back.click();
    await expect(timeline).toHaveAttribute("data-time", "14");
    await expect(back).toHaveCount(0);
    await expect(clock).toHaveText("2026-10-12 周一 14:00:02");
    await page.clock.fastForward(1000);
    await expect(clock).toHaveText("2026-10-12 周一 14:00:03");
    await page.clock.fastForward(3_600_000);
    await expect(timeline).toHaveAttribute("data-time", "15");
    await expect(clock).toHaveText("2026-10-12 周一 15:00:03");
  });
}
