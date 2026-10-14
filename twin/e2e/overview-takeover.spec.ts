import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
const start = Date.parse("2026-10-12T14:00:00+08:00");
const record = {
  id: "t1",
  version: 1,
  date: "2026-10-12",
  hour: 14,
  start_ms: start,
  end_ms: start + 7200000,
  hvac_setpoint_c: 26,
  storage_mode: "discharge",
  storage_power_kw: 55,
  operator_id: "陈工",
  reason: "巡检",
  status: "active",
  record_status: "active",
};
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
]) {
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`overview takeover is read-only, hour-scoped, polled and geometry-stable ${size.width}`, async ({
    page,
  }, info) => {
    const { width, height } = size;
    test.setTimeout(90000);
    await freezeTestHmr(page);
    await page.setViewportSize({ width, height });
    let active = false,
      available = true,
      recordStatus = "active";
    const calls: { date: string | null; hour: string | null }[] = [];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/takeover/active") return route.abort();
      calls.push({
        date: url.searchParams.get("date"),
        hour: url.searchParams.get("hour"),
      });
      await route.fulfill(
        available
          ? {
              json: {
                api_version: "1",
                takeover:
                  active && url.searchParams.get("hour") === "14"
                    ? {
                        ...record,
                        record_status: recordStatus,
                        ...(recordStatus === "cancelled"
                          ? { cancelled_ms: start + 1800000 }
                          : {}),
                      }
                    : null,
              },
            }
          : {
              status: 404,
              contentType: "text/html",
              body: "<!doctype html>missing",
            },
      );
    });
    await page.goto("/?source=file&at=2026-10-12T14:00", {
      waitUntil: "domcontentloaded",
    });
    const card = page.locator(".agent-verdict"),
      banner = page.locator(".overview-takeover");
    await expect(card).toBeVisible();
    await expect(page.locator(".dispatch-note")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500); // Let the existing page-entry transform settle before measuring.
    expect(calls[0]).toEqual({ date: "2026-10-12", hour: "14" });
    await expect(banner).toHaveCount(0);
    const geometry = () =>
      card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    const before = await geometry();
    const original = (await card
      .locator(".overview-verdict-default")
      .textContent())!;
    active = true;
    // No event: periodic GET must discover the takeover.
    await expect(banner).toBeVisible({ timeout: 7000 });
    await expect(banner).toContainText(
      "人工接管中 · 操作人 陈工 · 剩余 2 小时",
    );
    await expect(banner).toContainText("人工设定温度 26.0 °C");
    await expect(banner).toContainText("储能 放电 55.0 kW");
    if (width > 1180) expect(await geometry()).toEqual(before);
    else {
      const compact = await geometry();
      expect(compact.height).toBeLessThan(before.height);
      expect(compact.height).toBeLessThan(260);
    }
    await expect(card.getByRole("button")).toHaveCount(0);
    const slider = page.getByRole("slider", { name: "24 小时时间轴" });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect.poll(() => calls.at(-1)?.hour).toBe("15");
    await expect(banner).toHaveCount(0);
    await slider.press("ArrowLeft");
    await expect(banner).toBeVisible();
    recordStatus = "cancelled";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const notice = card.locator(".overview-takeover-cancelled");
    await expect(notice).toHaveText(
      "本小时人工接管已撤销 · 撤销时间 2026-10-12 14:30 · 操作人 陈工",
    );
    await expect(banner).toHaveCount(0);
    const noticeLayout = await card.evaluate((el) => {
      const notice = el.querySelector<HTMLElement>(
        ".overview-takeover-cancelled",
      )!;
      const source = el.querySelector<HTMLElement>(
        ".overview-verdict-default > small",
      )!;
      const a = notice.getBoundingClientRect(),
        b = source.getBoundingClientRect();
      return {
        bottom: a.bottom,
        sourceTop: b.top,
        position: getComputedStyle(notice).position,
        fontSize: parseFloat(getComputedStyle(notice).fontSize),
      };
    });
    expect(noticeLayout.position).toBe("static");
    expect(noticeLayout.fontSize).toBeGreaterThanOrEqual(12);
    expect(noticeLayout.bottom).toBeLessThanOrEqual(noticeLayout.sourceTop);
    await card.screenshot({
      path: info.outputPath(`cancelled-${width}x${height}.png`),
    });
    await expect(card.locator(".overview-verdict-default")).toBeVisible();
    await expect(card.locator(".overview-verdict-default")).toHaveText(
      original,
    );
    await expect(card).not.toContainText(
      /人工设定温度|储能 放电 55.0|剩余|人工接管中/,
    );
    if (width > 1180) {
      expect(await geometry()).toEqual(before);
      const visible = await card.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const notice = el
          .querySelector(".overview-takeover-cancelled")!
          .getBoundingClientRect();
        const note = el
          .querySelector(".dispatch-note")!
          .getBoundingClientRect();
        return notice.top >= bounds.top && note.bottom <= bounds.bottom;
      });
      expect(visible).toBe(true);
    } else {
      expect((await geometry()).height).toBeGreaterThan(before.height);
      const bottomBlank = await card.evaluate(
        (el) =>
          el.getBoundingClientRect().bottom -
          el.querySelector(".dispatch-note")!.getBoundingClientRect().bottom,
      );
      expect(bottomBlank).toBeLessThan(25);
    }
    recordStatus = "expired";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner).toHaveCount(0);
    await expect(card.locator(".overview-takeover-cancelled")).toHaveCount(0);
    await expect(card.locator(".overview-verdict-default")).toHaveText(
      original,
    );
    recordStatus = "active";
    available = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner).toHaveCount(0);
    await expect(page.locator(".dispatch-note")).toBeVisible();
    expect((await geometry()).height).toEqual(before.height);
    await expect(card).not.toContainText(
      /数值连续插值|整点决策|实时结果|BA设定|EMS储能/,
    );
    available = true;
    active = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner).toHaveCount(0);
  });
  });
}
for (const response of ["html", "missing-version"]) {
  test(`overview silently ignores unavailable backend ${response}`, async ({
    page,
  }) => {
    await freezeTestHmr(page);
    await page.route("**/api/**", (route) =>
      new URL(route.request().url()).pathname === "/api/takeover/active"
        ? route.fulfill(
            response === "html"
              ? { contentType: "text/html", body: "<!doctype html>" }
              : { json: { takeover: record } },
          )
        : route.abort(),
    );
    await page.goto("/?source=file&at=2026-10-12T14:00", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".dispatch-note")).toBeVisible();
    await expect(page.locator(".overview-takeover")).toHaveCount(0);
    await expect(page.locator(".agent-verdict")).not.toContainText(
      /服务暂不可用|接管|结论被覆盖/,
    );
  });
}
