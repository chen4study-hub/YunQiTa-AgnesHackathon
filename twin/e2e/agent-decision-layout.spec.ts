import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { assertDisplayText } from "./agent-forecast-visible";
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
];
for (const size of sizes)
  test.describe(`decision redesign ${size.width}`, () => {
    test.setTimeout(90000);
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    for (const scenario of ["normal", "abstain"])
      test(`${scenario}: left order, complete reasons, typography, controls and bounded desktop`, async ({
        page,
      }, info) => {
        await page.route("**/api/**", (r) => {
          const path = new URL(r.request().url()).pathname;
          const version = { api_version: "1.0", timezone: "Asia/Shanghai" };
          if (path === "/api/takeover/active")
            return r.fulfill({ json: { ...version, takeover: null } });
          if (path === "/api/takeover/history")
            return r.fulfill({ json: { ...version, items: [] } });
          if (path === "/api/takeover/recommendation")
            return r.fulfill({
              json: {
                ...version,
                available: true,
                hvac_setpoint_c: 25.6,
                storage_mode: "idle",
                storage_power_kw: 0,
                duration_hours: 3,
                reason: "已核验推荐",
                recommendation_hash: "layout-fixture",
              },
            });
          return r.abort();
        });
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
        );
        await page.getByRole("button", { name: "Agent 决策" }).click();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(320);
        const card = page.locator(".agent-redesign");
        await expect(
          page.getByRole("button", { name: "人工接管", exact: true }),
        ).toBeEnabled();
        await expect(card).toBeVisible();
        await expect(page.locator(".agent-steps li")).toHaveCount(6);
        await assertDisplayText(page);
        await expect(card).not.toContainText(
          /get_forecast|simulate_schedule|check_grounding/,
        );
        await expect(page.locator(".agent-steps li").first()).toHaveAttribute(
          "title",
          "get_forecast",
        );
        const m = await page.evaluate(() => {
          const el = (s: string) => document.querySelector(s) as HTMLElement;
          const box = (s: string) => el(s).getBoundingClientRect().toJSON();
          const css = (s: string) => getComputedStyle(el(s));
          const regions = [
            ".agent-heading",
            ".agent-status-bar",
            ".agent-plan",
            ".agent-evidence-row",
            ".agent-reason-section",
          ].map((s) => ({ s, box: box(".agent-redesign " + s) }));
          const scrolls = [...document.querySelectorAll(".agent-left-slot *")]
            .filter((e) => !(e as HTMLElement).closest("dialog"))
            .filter(
              (e) =>
                ["auto", "scroll"].includes(getComputedStyle(e).overflowY) &&
                (e as HTMLElement).scrollHeight >
                  (e as HTMLElement).clientHeight + 1,
            )
            .map((e) => e.className);
          const metrics = [...document.querySelectorAll(".agent-plan li")].map(
            (e) => {
              const value = e.querySelector("strong")!,
                number = value.querySelector(".smooth-value")!,
                unit = value.querySelector("small")!,
                label = e.querySelector(".agent-plan-label")!;
              return {
                text: value.textContent,
                numberText: number.textContent,
                unitText: unit.textContent,
                box: e.getBoundingClientRect().toJSON(),
                label: label.getBoundingClientRect().toJSON(),
                value: value.getBoundingClientRect().toJSON(),
                number: number.getBoundingClientRect().toJSON(),
                unit: unit.getBoundingClientRect().toJSON(),
                font: parseFloat(getComputedStyle(value).fontSize),
                ufont: parseFloat(getComputedStyle(unit).fontSize),
                align: getComputedStyle(value).alignItems,
              };
            },
          );
          return {
            regions,
            metrics,
            scrolls,
            left: box(".agent-left-slot"),
            leftHeight: el(".agent-left-slot").clientHeight,
            leftScroll: el(".agent-left-slot").scrollHeight,
            recordRows: [...el(".agent-record-card tbody").children].map((e) =>
              e.getBoundingClientRect().toJSON(),
            ),
            recordViewport: box(".agent-record-card .agent-table-scroll"),
            recordHeight: el(".agent-record-card .agent-table-scroll")
              .clientHeight,
            recordScroll: el(".agent-record-card .agent-table-scroll")
              .scrollHeight,
            expandHeight: el(
              ".agent-plan-reason > button",
            ).getBoundingClientRect().height,
            reasonBottom: box(".agent-reason-preview").bottom,
            storage: [
              ...document.querySelectorAll(".agent-candidate-storage"),
            ].map((e) => ({
              box: e.getBoundingClientRect().toJSON(),
              value: e
                .querySelector(".smooth-value")!
                .getBoundingClientRect()
                .toJSON(),
              text: e.textContent,
            })),
            records: box(".agent-record-card"),
            footer: box(".bottombar"),
            chat: box(".agent-chat-card"),
            docHeight: document.scrollingElement!.scrollHeight,
            docWidth: document.scrollingElement!.scrollWidth,
            recordAlign: css(".agent-record-card td:last-child").textAlign,
            tableFont: css(".agent-record-card td:nth-child(2)").fontFamily,
            preview: css(".agent-reason-preview").display,
            clamp: css(".agent-reason-preview").webkitLineClamp,
            actions: box(".agent-actions"),
            buttons: [...el(".agent-actions").querySelectorAll("button")].map(
              (e) => ({
                ...e.getBoundingClientRect().toJSON(),
                scrollWidth: e.scrollWidth,
                clientWidth: e.clientWidth,
                scrollHeight: e.scrollHeight,
                clientHeight: e.clientHeight,
              }),
            ),
          };
        });
        expect(m.docWidth).toBeLessThanOrEqual(size.width);
        expect(m.recordAlign).toBe("right");
        for (const family of await page
          .locator(".agent-page .card h2,.agent-page .card h3")
          .evaluateAll((es) => es.map((e) => getComputedStyle(e).fontFamily)))
          expect(family).not.toMatch(/Mono|monospace/);
        expect(m.tableFont).not.toMatch(/Mono|monospace/);
        expect(m.clamp).toBe("none");
        await expect(card).not.toContainText("耗时未提供");
        if (size.width < 1600)
          expect(m.buttons[0].top - m.reasonBottom).toBeGreaterThanOrEqual(8);
        expect(m.recordRows).toHaveLength(6);
        if (scenario === "normal") {
          const padding = await page
            .locator(".agent-selected th")
            .evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
          expect(padding).toBeGreaterThanOrEqual(8);
          for (const cell of m.storage)
            expect(cell.value.height).toBeLessThanOrEqual(
              size.width === 390 ? 44 : 22,
            );
        }
        expect(
          m.scrolls.filter((c) => !String(c).includes("agent-table-scroll")),
        ).toEqual([]);
        for (let i = 1; i < m.regions.length; i++)
          expect(m.regions[i].box.top).toBeGreaterThanOrEqual(
            m.regions[i - 1].box.bottom - 1,
          );
        for (const v of m.metrics) {
          expect(v.label.bottom).toBeLessThanOrEqual(v.value.top + 1);
          // faa4164 replaces CSS spacing with one explicit text separator.
          expect(v.unitText).toMatch(/^[ \u00a0][^ \u00a0]/);
          expect(v.text?.replace(/\u00a0/g, " ")).toBe(
            `${v.numberText} ${v.unitText?.slice(1)}`,
          );
          expect(v.align).toBe("baseline");
          expect(v.ufont / v.font).toBeGreaterThanOrEqual(0.4);
          expect(v.ufont / v.font).toBeLessThanOrEqual(0.55);
          expect(v.value.left).toBe(v.label.left);
        }
        expect(
          m.buttons.every(
            (b) =>
              Math.abs(b.top - m.buttons[0].top) < 1 &&
              Math.abs(b.height - m.buttons[0].height) < 1,
          ),
          JSON.stringify(m.buttons),
        ).toBe(true);
        for (const [i, b] of m.buttons.entries()) {
          expect(b.left).toBeGreaterThanOrEqual(m.actions.left);
          expect(b.right).toBeLessThanOrEqual(m.actions.right + 0.5);
          expect(b.top).toBeGreaterThanOrEqual(m.actions.top);
          expect(b.bottom).toBeLessThanOrEqual(m.actions.bottom + 0.5);
          expect(b.scrollWidth).toBeLessThanOrEqual(b.clientWidth + 1);
          expect(b.scrollHeight).toBeLessThanOrEqual(b.clientHeight + 1);
          if (i) expect(b.left).toBeGreaterThanOrEqual(m.buttons[i - 1].right);
        }
        if (size.width > 1000) {
          expect(m.docHeight).toBe(size.height);
          // Larger type may overflow the independent left column.
          expect(m.chat.bottom).toBeLessThanOrEqual(m.footer.top);
          expect(
            Math.max(...m.metrics.map((v) => v.box.width)) -
              Math.min(...m.metrics.map((v) => v.box.width)),
          ).toBeLessThan(1);
        } else {
          expect(m.expandHeight).toBeGreaterThanOrEqual(36);
          expect(m.docHeight).toBeGreaterThan(size.height);
          // bd76dfb: upper/temperature side by side; storage second row.
          expect(m.metrics[0].box.top).toBe(m.metrics[1].box.top);
          expect(m.metrics[2].box.top).toBeGreaterThanOrEqual(
            m.metrics[0].box.bottom,
          );
          expect(
            m.metrics[0].box.height + m.metrics[1].box.height,
          ).toBeLessThan(150);
        }
        await info.attach("redesign", {
          body: await page.screenshot({
            path: info.outputPath("redesign.png"),
            fullPage: true,
          }),
          contentType: "image/png",
        });
        await page.getByRole("button", { name: "展开调度理由" }).click();
        await expect(
          page.getByRole("dialog", { name: "完整调度理由" }),
        ).toBeVisible();
        await expect(page.locator(".agent-reason-full")).not.toBeEmpty();
        await page.keyboard.press("Escape");
        if (scenario === "normal") {
          await page.getByRole("button", { name: "查看执行回执" }).click();
          await expect(
            page.getByRole("dialog", { name: "执行回执" }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await page
            .getByRole("button", { name: "人工接管", exact: true })
            .click();
          await expect(
            page.getByRole("dialog", { name: "人工接管配置" }),
          ).toBeVisible();
        } else {
          await page.getByRole("button", { name: "查看人工工单" }).click();
          await expect(
            page.getByRole("dialog", { name: "人工工单" }),
          ).toContainText("建议检查");
          await page.keyboard.press("Escape");
        }
      });
  });
