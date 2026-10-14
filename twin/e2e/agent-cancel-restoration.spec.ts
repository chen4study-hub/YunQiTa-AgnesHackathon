import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
test.skip(
  process.env.AGENT_TAKEOVER_LIVE !== "1",
  "Disposable 4183 database opt-in",
);
for (const width of [390, DESKTOP_125.width])
  for (const failure of [false, true])
    test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`${width} cancellation placeholder within 500ms, ${failure ? "failed" : "confirmed"} schedule replaces it with CLS zero`, async ({
      page,
    }, info) => {
      expect(info.project.use.baseURL).toBe(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4183}`);
      await currentUI4183(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : DESKTOP_125.height });
      await page.goto("/?scenario=normal&at=2026-10-13T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page.evaluate(() => document.fonts.ready);
      const actor = `AgnesRestore-${Date.now()}`;
      await page.getByRole("button", { name: "人工接管", exact: true }).click();
      const form = page.getByRole("dialog", { name: "人工接管配置" });
      await form.getByLabel("持续小时").fill("1");
      await form.getByLabel("设定温度（°C）").fill("26");
      await form.getByLabel("储能模式").selectOption("idle");
      await form.getByLabel("操作人", { exact: true }).fill(actor);
      let id = "",
        delay = false,
        release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await page.route("**/api/schedule", async (route) => {
        if (!delay) return route.continue();
        const response = await route.fetch();
        await gate;
        await route.fulfill(
          failure
            ? { status: 503, json: { detail: "restoration test unavailable" } }
            : { response },
        );
      });
      try {
        const created = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/takeover" &&
            r.request().method() === "POST",
        );
        await form.getByRole("button", { name: "提交接管" }).click();
        id = (await (await created).json()).takeover.id;
        await expect(page.locator(".agent-decision-source")).toHaveText(
          "人工配置",
          { timeout: 50000 },
        );
        await page
          .getByRole("button", { name: "撤销接管", exact: true })
          .click();
        await page.getByLabel("撤销原因", { exact: true }).fill("恢复占位终验");
        delay = true;
        await page.evaluate(() => {
          const w = window as any;
          w.restoreSeen = null;
          w.cancelAt = null;
          new MutationObserver(() => {
            const e = document.querySelector(
              '.agent-status-bar[data-restoration="pending"]',
            );
            if (e && w.restoreSeen === null) w.restoreSeen = performance.now();
          }).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          });
          const original = window.fetch;
          window.fetch = async (...args) => {
            const response = await original(...args);
            if (response.url.includes("/cancel"))
              w.cancelAt = performance.now();
            return response;
          };
        });
        await page.evaluate(() => {
          const w = window as any;
          w.restoreShifts = [];
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              w.restoreShifts.push({
                value: (e as any).value,
                recent: (e as any).hadRecentInput,
                sources: (e as any).sources?.map((s: any) => s.node?.className),
              });
          }).observe({ type: "layout-shift", buffered: false });
        });
        const cancel = page.waitForResponse((r) =>
          r.url().endsWith(`/takeover/${id}/cancel`),
        );
        await page
          .getByRole("button", { name: "确认撤销", exact: true })
          .click();
        await cancel;
        const bar = page.locator(".agent-status-bar");
        await expect(bar).toHaveAttribute("data-restoration", "pending", {
          timeout: 500,
        });
        await expect(
          bar.locator("span").filter({ hasText: "自动调度恢复中…" }),
        ).toBeVisible();
        const timing = await page.evaluate(() => ({
          start: (window as any).cancelAt,
          end: (window as any).restoreSeen,
        }));
        expect(timing.start).not.toBeNull();
        expect(timing.end).not.toBeNull();
        expect(timing.end - timing.start).toBeLessThanOrEqual(500);
        await expect(page.locator(".agent-takeover-cancelled")).toContainText(
          actor,
        );
        await bar.scrollIntoViewIfNeeded();
        await page.waitForTimeout(700);
        const bounds = await bar.boundingBox();
        await page.waitForTimeout(3300);
        await expect(bar).toHaveAttribute("data-restoration", "pending");
        await page.screenshot({ path: info.outputPath("restoring.png") });
        release();
        await expect(bar).toHaveAttribute("aria-busy", "false", {
          timeout: 50000,
        });
        await expect(bar).toContainText(
          failure ? "暂时拿不到最新调度，请稍后刷新" : "已自动下发 · 执行中",
        );
        await expect(
          bar.getByText(
            failure ? "暂时拿不到最新调度，请稍后刷新" : "已自动下发 · 执行中",
            { exact: true },
          ),
        ).toBeVisible();
        await page.waitForTimeout(700);
        expect(await bar.boundingBox()).toEqual(bounds);
        const shifts = await page.evaluate(() => (window as any).restoreShifts);
        const cls = shifts
          .filter((s: any) => !s.recent)
          .reduce((sum: number, s: any) => sum + s.value, 0);
        await info.attach("restoration-evidence", {
          body: JSON.stringify({ timing, bounds, cls, shifts }),
          contentType: "application/json",
        });
        console.log(
          JSON.stringify({ width, failure, timing, bounds, cls, shifts }),
        );
        expect(cls).toBe(0);
        await page.screenshot({ path: info.outputPath("restored.png") });
      } finally {
        release();
        if (id) {
          const h = await (
            await page.request.get(
              "/api/takeover/history?date=2026-10-13&limit=200",
            )
          ).json();
          const r = h.items.find((r: any) => r.id === id);
          if (r && !r.cancelled_at)
            await page.request.post(`/api/takeover/${id}/cancel`, {
              data: {
                operator_id: actor,
                reason: "终验清理",
                expected_version: r.version,
              },
            });
        }
      }
    });
  });
