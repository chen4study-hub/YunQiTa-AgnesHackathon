import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
];
for (const size of sizes)
  test.describe(`readable tabs ${size.width}`, () => {
    test.setTimeout(90000);
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    for (const scenario of ["normal", "abstain"])
      test(`${scenario}: measured type/spacing, complete records and no card scroll`, async ({
        page,
      }, info) => {
        const data = JSON.parse(
            readFileSync(`public/replay/${scenario}.json`, "utf8"),
          ),
          schema = JSON.parse(
            readFileSync("src/data/contracts/replay.schema.json", "utf8"),
          );
        data.energy_summary.label =
          schema.properties.energy_summary.properties.label.const;
        await page.route(`**/replay/${scenario}.json`, (r) =>
          r.fulfill({ json: data }),
        );
        await page.route("**/api/**", (r) => r.abort());
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
        );
        await page.getByRole("button", { name: "Agent 决策" }).click();
        await expect(page.locator(".agent-redesign")).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        const measure = () =>
          page.evaluate(() => {
            const el = (s: string) => document.querySelector(s) as HTMLElement,
              box = (s: string) => el(s).getBoundingClientRect().toJSON(),
              css = (s: string) => getComputedStyle(el(s));
            const card = el(".agent-redesign"),
              r = el(".agent-record-card");
            const regions = [
              ".agent-heading",
              ".agent-status-bar",
              ".agent-plan",
              ".agent-evidence-row",
              ".agent-reason-section",
              ].map((s) => box(".agent-redesign " + s));
            return {
              pad: css(".agent-redesign").padding,
              body: css(".agent-step-result").fontSize,
              reason: css(".agent-reason-preview").fontSize,
              table: css(
                card.querySelector(".agent-comparison table")
                  ? ".agent-comparison table"
                  : ".agent-record-card table",
              ).fontSize,
              regions,
              stepRows: [...el(".agent-steps").children].map(
                (e) => e.getBoundingClientRect().height,
              ),
              tableRows: [
                ...card.querySelectorAll(".agent-comparison tbody tr"),
              ].map((e) => e.getBoundingClientRect().height),
              headerCells: [
                ...card.querySelectorAll(".agent-comparison thead th"),
              ].map((e) => ({
                width: e.clientWidth,
                scroll: e.scrollWidth,
                wrap: getComputedStyle(e).whiteSpace,
              })),
              chain: box(".agent-chain"),
              comparison: box(".agent-comparison"),
              smallGap:
                box(".agent-chain .agent-steps").top -
                box(".agent-chain h3").bottom,
              left: box(".agent-left-slot"),
              chat: box(".agent-chat-card"),
              card: card.getBoundingClientRect().toJSON(),
              records: r.getBoundingClientRect().toJSON(),
              rootScroll: el(".agent-root").scrollHeight,
              rootHeight: el(".agent-root").clientHeight,
              leftScroll: el(".agent-left-slot").scrollHeight,
              leftHeight: el(".agent-left-slot").clientHeight,
              cardScroll: card.scrollHeight,
              cardHeight: card.clientHeight,
              docWidth: document.scrollingElement!.scrollWidth,
              docHeight: document.scrollingElement!.scrollHeight,
              overflow: [...card.querySelectorAll("*")]
                .filter(
                  (e) =>
                    !(e as HTMLElement).closest("dialog") &&
                    ["auto", "scroll"].includes(
                      getComputedStyle(e).overflowY,
                    ) &&
                    e.scrollHeight > e.clientHeight + 1,
                )
                .map((e) => e.className),
            };
          });
        const m = await measure();
        expect(m.docWidth).toBeLessThanOrEqual(size.width);
        expect(m.overflow).toEqual([]);
        const desktop = size.width > 1000,
          compact = desktop && size.width < 1800;
        if (desktop) {
          expect(m.pad).toBe("12px");
          expect(m.body).toBe("14px");
          expect(parseFloat(m.reason)).toBeGreaterThanOrEqual(size.width <= 1366 ? 14 : 15);
          expect(m.table).toBe("14px");
          for (const h of [...m.stepRows, ...m.tableRows])
            expect(h).toBeGreaterThanOrEqual(31);
          for (let i = 1; i < m.regions.length; i++)
            expect(m.regions[i].top - m.regions[i - 1].bottom).toBeCloseTo(
              size.width >= 1600 ? 10 : 12,
              0,
            );
          expect(m.smallGap).toBeCloseTo(6, 0);
          if (size.width >= 1600) expect(m.chain.top).toBe(m.comparison.top);
          else expect(m.comparison.top).toBeGreaterThan(m.chain.bottom);
          expect(m.docHeight).toBe(size.height);
          expect(m.rootScroll).toBeLessThanOrEqual(m.rootHeight + 1);
          expect(m.cardScroll).toBeLessThanOrEqual(m.cardHeight + 1);
          expect(m.card.top).toBe(m.chat.top);
          for (const c of m.headerCells) {
            expect(c.wrap).toBe("nowrap");
            expect(c.scroll).toBeLessThanOrEqual(c.width + 1);
          }
        } else {
          expect(parseFloat(m.body)).toBeGreaterThanOrEqual(14);
          expect(parseFloat(m.table)).toBeGreaterThanOrEqual(14);
        }
        if (compact) {
          await expect(page.locator(".agent-record-card")).toBeHidden();
          await page
            .getByRole("tab", { name: "近期记录（6 小时）", exact: true })
            .click();
          await expect(page.locator(".agent-redesign")).toBeHidden();
          await expect(page.locator(".agent-record-card")).toBeVisible();
        }
        const records = await page
          .locator(".agent-record-card")
          .evaluate((e) => {
            const v = e.querySelector(".agent-table-scroll")!,
              r = e.getBoundingClientRect();
            return {
              box: r.toJSON(),
              rows: [...e.querySelectorAll("tbody tr")].map((n) =>
                n.getBoundingClientRect().toJSON(),
              ),
              height: e.clientHeight,
              scroll: e.scrollHeight,
              viewport: v.getBoundingClientRect().toJSON(),
              vh: v.clientHeight,
              vs: v.scrollHeight,
            };
          });
        expect(records.rows).toHaveLength(6);
        if (desktop) {
          expect(records.scroll).toBeLessThanOrEqual(records.height + 1);
          expect(records.vs).toBeLessThanOrEqual(records.vh + 1);
          expect(records.rows[5].bottom).toBeLessThanOrEqual(
            records.box.bottom,
          );
        }
        if (compact) {
          await info.attach("records-tab", {
            body: await page.screenshot({
              path: info.outputPath("records-tab.png"),
            }),
            contentType: "image/png",
          });
          await page
            .getByRole("tab", { name: "当前决策", exact: true })
            .click();
          await expect(page.locator(".agent-redesign")).toBeVisible();
        }
        console.log(
          JSON.stringify({
            width: size.width,
            scenario,
            padding: m.pad,
            body: m.body,
            table: m.table,
            stepRow: m.stepRows[0],
            candidateRow: m.tableRows[0],
            blockGap: m.regions[1].top - m.regions[0].bottom,
            subtitleGap: m.smallGap,
          }),
        );
        await info.attach("default", {
          body: await page.screenshot({
            path: info.outputPath("default.png"),
            fullPage: !desktop,
          }),
          contentType: "image/png",
        });
        await page.getByRole("button", { name: "展开调度理由" }).click();
        await expect(
          page.getByRole("dialog", { name: "完整调度理由" }),
        ).toBeVisible();
        await expect(page.locator(".agent-reason-full")).not.toBeEmpty();
        await page.keyboard.press("Escape");
        await info.attach("current", {
          body: await page.screenshot({
            path: info.outputPath("current.png"),
            fullPage: !desktop,
          }),
          contentType: "image/png",
        });
      });
  });
