import { freezeTestHmr } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => freezeTestHmr(page));
import { setTimelineHour } from "./timeline-helper";
import {
  installCanvasTextAudit,
  clearCanvasTextAudit,
  canvasTexts,
  visitAuditPage,
  chartHosts,
  auditPages,
} from "./canvas-text-audit";
test.beforeEach(async ({ page }) => installCanvasTextAudit(page));
const forbidden = [
  "影子模式",
  "模拟",
  "估算",
  "估计",
  "回放",
  "历史回放",
  "待人工确认",
  "演示",
  "典型日",
  "情景",
  "代表日",
  "游标",
  "推算",
  "沿用",
  "非实测",
  "不是今天的实时测量",
];
// Three data-day types plus both sides of midnight, using real at dates.
const languageCases = [
  { scenario: "normal", at: "2026-10-12T14:00" },
  { scenario: "peak", at: "2026-07-13T14:00" },
  { scenario: "abstain", at: "2026-10-01T14:00" },
  { scenario: "normal", at: "2026-10-12T23:57" },
  { scenario: "normal", at: "2026-10-13T00:03" },
];
for (const source of ["file", "mock"])
  for (const { scenario: day, at } of languageCases)
    test(`visible language and BDG2 attribution across six pages: ${source} ${day} ${at}`, async ({
      page,
    }, info) => {
      test.setTimeout(180000);
      await page.route("**/api/**", (r) => r.abort());
      await page.goto(`/?source=${source}&scenario=${day}&at=${at}`);
      await expect(page.locator(".overview-number")).toHaveCount(3);
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      const violations: unknown[] = [],
        coverage: unknown[] = [];
      // Inspect the exact at time first; retain the existing 0/14/23 seek coverage.
      for (const hour of [null, 0, 14, 23])
        for (const [name, id] of auditPages) {
          await clearCanvasTextAudit(page);
          await visitAuditPage(page, name, id);
          if (hour !== null) {
            await setTimelineHour(page, hour);
            await expect(page.locator(".timeline")).toHaveAttribute(
              "data-time",
              String(hour),
            );
          }
          await page.waitForTimeout(180);
          const hosts = await chartHosts(page);
          for (let i = 0; i < (await hosts.count()); i++) {
            const host = hosts.nth(i);
            await host.scrollIntoViewIfNeeded();
            await host.hover({ force: true });
            await page.waitForTimeout(180);
          }
          const painted = await canvasTexts(page);
          coverage.push({
            source,
            at,
            hour,
            page: name,
            charts: await hosts.count(),
            paints: painted.length,
          });
          if ((await hosts.count()) && !painted.length)
            violations.push({
              source,
              at,
              hour,
              page: name,
              missing: "canvas text coverage",
            });
          const text = await page.locator("body").innerText();
          const entries = [
            ...text.split("\n").map((text) => ({ kind: "innerText", text })),
            ...(await page
              .locator("[title],[aria-label]")
              .evaluateAll((elements) =>
                elements
                  .filter((el) =>
                    el.checkVisibility({ checkVisibilityCSS: true }),
                  )
                  .flatMap((el) =>
                    ["title", "aria-label"].map((kind) => ({
                      kind,
                      text: el.getAttribute(kind) ?? "",
                      element: el.tagName + "." + el.className,
                    })),
                  ),
              )),
            ...painted.map((sample) => ({
              kind: "canvas",
              ...sample,
            })),
          ];
          for (const entry of entries) {
            const words = forbidden.filter((word) => entry.text.includes(word));
            if (words.length)
              violations.push({
                source,
                day,
                at,
                hour,
                page: name,
                ...entry,
                words,
              });
          }
          if (!/BDG2.*Miller.*CC BY-SA 4\.0/.test(text))
            violations.push({
              day,
              hour,
              page: name,
              missing: "BDG2 attribution",
            });
        }
      await info.attach("visible-language-violations.json", {
        body: JSON.stringify(violations, null, 2),
        contentType: "application/json",
      });
      await info.attach("language-coverage.json", {
        body: JSON.stringify(coverage, null, 2),
        contentType: "application/json",
      });
      console.log("LANGUAGE_VIOLATIONS " + JSON.stringify(violations));
      expect(violations).toEqual([]);
    });
test("mobile overview texts are at least 12px and BDG2 credit is visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?source=file");
  await expect(page.locator(".overview-number")).toHaveCount(3);
  const tiny = await page
    .locator(".topbar,.bottombar,.overview-grid")
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [...root.querySelectorAll<HTMLElement>("*")]
          .filter(
            (el) =>
              el.checkVisibility({ checkVisibilityCSS: true }) &&
              [...el.childNodes].some(
                (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
              ) &&
              parseFloat(getComputedStyle(el).fontSize) < 12,
          )
          .map((el) => ({
            text: el.textContent,
            selector: el.className,
            size: getComputedStyle(el).fontSize,
          })),
      ),
    );
  expect(tiny).toEqual([]);
  await expect(page.locator(".bottombar")).toContainText(
    "BDG2 · Miller et al., 2020 · CC BY-SA 4.0",
  );
  expect(
    await page
      .locator(".bottombar")
      .evaluate((el) => el.innerText.includes("BDG2")),
  ).toBe(true);
});
