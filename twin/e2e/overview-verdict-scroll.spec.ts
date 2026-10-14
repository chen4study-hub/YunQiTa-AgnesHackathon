import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";

for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`verdict internal scroll ${size.width}@${size.dpr}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("long live schedule stays inside unchanged cards; short content has no scroll; export remains bounded", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await freezeTestHmr(page);
      await page.clock.install({ time: new Date("2026-10-13T04:00:00+08:00") });
      let long = true;
      const reason =
        "负荷预测偏低但上限仍需核验，储能保留备用电量；本小时选择全额调度，设备设定保持不变，后续小时依据最新预测重新判断。";
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/takeover/active")
          return route.fulfill({ json: { api_version: "1", takeover: null } });
        if (path !== "/api/schedule") return route.abort();
        const body = route.request().postDataJSON();
        const command = {
          timestamp: body.start,
          hvac_setpoint_c: 25.5,
          battery_kw: 0,
          action: "execute",
        };
        return route.fulfill({
          json: {
            building_id: body.building_id,
            source: "rule",
            explanation_source: "template",
            selected: "full",
            plan: [command],
            candidates: [
              {
                candidate_id: "full",
                name: "全额调度",
                passed: true,
                plan: [command],
              },
            ],
            reason: long ? reason.repeat(12) : "当前小时选择全额调度。",
            receipt: {
              count: 1,
              transport: "log_only",
              device_connected: false,
            },
          },
        });
      });
      const card = page.locator(".agent-verdict");
      const body = card.locator(".verdict-body");
      const forecast = page.locator(".overview-forecast");
      const geometry = () =>
        page.evaluate(() => {
          const rect = (selector: string) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          return {
            card: rect(".agent-verdict"),
            forecast: rect(".overview-forecast"),
          };
        });
      const bounds = () =>
        body.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            card = el.closest(".agent-verdict")!.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            cardTop: card.top,
            cardBottom: card.bottom,
            cardLeft: card.left,
            cardRight: card.right,
            overflow: style.overflowY,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            font: getComputedStyle(el.querySelector("p")!).fontSize,
          };
        });
      const assertBounded = async () => {
        const b = await bounds();
        expect(b.top).toBeGreaterThanOrEqual(b.cardTop);
        expect(b.bottom).toBeLessThanOrEqual(b.cardBottom - 1);
        expect(b.left).toBeGreaterThanOrEqual(b.cardLeft);
        expect(b.right).toBeLessThanOrEqual(b.cardRight);
        return b;
      };
      // No at parameter: exercise the current-hour live schedule, not only exported text.
      await page.goto("/?source=file", { waitUntil: "domcontentloaded" });
      await expect(body).toHaveAttribute("data-decision-source", "schedule");
      await expect(card.locator(".overview-selected-plan")).toHaveText(
        "选择：全额调度",
      );
      await expect(card.locator(".overview-storage-power")).toContainText(
        "待机",
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const initial = await geometry();
      const full = await assertBounded();
      const shell = card.locator(".overview-verdict-scroll-shell");
      const footer = card.locator(".overview-verdict-footer");
      await expect(footer).toHaveText("整点调度 · 回执已记录");
      expect(await body.locator(".dispatch-note").count()).toBe(0);
      const initialFooter = await footer.boundingBox();
      const cardBox = await card.boundingBox();
      expect(initialFooter!.y + initialFooter!.height).toBeLessThan(
        cardBox!.y + cardBox!.height,
      );
      expect(initialFooter!.height).toBeGreaterThanOrEqual(19);
      if (size.width > 1180) await card.screenshot({ path: info.outputPath("long-live-top.png") });
      if (size.width > 1180) {
        expect(full.overflow).toBe("auto");
        expect(full.scrollHeight).toBeGreaterThan(full.clientHeight);
        await expect(shell).toHaveAttribute("data-more-below", "true");
        expect(initialFooter!.y).toBeGreaterThanOrEqual(full.bottom);
        expect(
          await shell.evaluate((el) => getComputedStyle(el, "::after").content),
        ).not.toBe("none");
        await body.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      } else {
        expect(full.scrollHeight - full.clientHeight).toBeLessThanOrEqual(1);
      }
      await expect(shell).toHaveAttribute("data-more-below", "false");
      expect(await footer.boundingBox()).toEqual(initialFooter);
      const storage = await card
        .locator(".overview-storage-power")
        .boundingBox();
      expect(storage!.y + storage!.height).toBeLessThanOrEqual(full.bottom + 1);
      expect(storage!.y).toBeGreaterThanOrEqual(full.top);
      expect(await geometry()).toEqual(initial);
      await card.screenshot({ path: info.outputPath("long-live.png") });
      long = false;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(body).toHaveAttribute("data-decision-source", "schedule");
      await expect(body.locator("p")).toHaveText("当前小时选择全额调度。");
      await page.waitForTimeout(500);
      const short = await assertBounded();
      expect(short.scrollHeight - short.clientHeight).toBeLessThanOrEqual(1);
      expect(short.font).toBe(full.font);
      await expect(shell).toHaveAttribute("data-more-below", "false");
      expect(
        await shell.evaluate((el) => getComputedStyle(el, "::after").content),
      ).toBe("none");
      if (size.width > 1180)
        expect(await footer.boundingBox()).toEqual(initialFooter);
      if (size.width > 1180) expect(await geometry()).toEqual(initial);
      else
        expect((await geometry()).card.height).toBeLessThan(
          initial.card.height,
        );
      // Also cover the requested fixed-time URL with the exported decision path.
      await page.unroute("**/api/**");
      await page.route("**/api/**", (route) => route.abort());
      await page.goto("/?source=file&at=2026-10-13T04:00", {
        waitUntil: "domcontentloaded",
      });
      await expect(body).toHaveAttribute("data-decision-source", "replay");
      await expect(body.locator("p").first()).not.toBeEmpty();
      await page.waitForTimeout(500);
      await assertBounded();
      await expect(forecast).toBeAttached();
    });
  });
  });
