import { expect, type Page } from "@playwright/test";
import { assertShellScrolling } from "./shell-scroll-policy";
/** Reachability, not a first-screen height budget. Preserve real clipping checks. */
export async function assertAlertsReachable(
  page: Page,
  context: string,
  requireData = true,
) {
  const table = page.locator(".energy-alert-table");
  await expect(table.locator("thead")).toBeVisible();
  await expect(table.locator("tbody tr:first-child")).toBeVisible();
  const hasData = (await table.locator("tbody tr[data-alert-id]").count()) > 0;
  if (requireData) expect(hasData, context + ": expected real alert data").toBe(true);
  const rowSelector = hasData
    ? "tbody tr[data-alert-id]:first-child"
    : "tbody tr:first-child";
  if (!hasData) await expect(table.locator(rowSelector)).toHaveText("暂无告警与工单");
  await page.locator("main").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The page may own the necessary vertical scrolling inside fixed desktop main.
  await page.locator(".energy-page").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.locator(".energy-table-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  let geometry: unknown;
  await expect
    .poll(
      async () => {
        const rows = await table
          .locator("thead," + rowSelector)
          .evaluateAll((es) =>
            es.map((el) => {
              const r = el.getBoundingClientRect();
              let top = 0,
                bottom = innerHeight,
                left = 0,
                right = innerWidth;
              for (let p = el.parentElement; p; p = p.parentElement) {
                const css = getComputedStyle(p),
                  box = p.getBoundingClientRect();
                if (
                  ["auto", "scroll", "hidden", "clip"].includes(css.overflowY)
                ) {
                  top = Math.max(top, box.top);
                  bottom = Math.min(bottom, box.bottom);
                }
                if (
                  ["auto", "scroll", "hidden", "clip"].includes(css.overflowX)
                ) {
                  left = Math.max(left, box.left);
                  right = Math.min(right, box.right);
                }
              }
              return {
                tag: el.tagName,
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                right: r.right,
                limitTop: top,
                limitBottom: bottom,
                complete:
                  el.checkVisibility({ checkVisibilityCSS: true }) &&
                  r.height > 0 &&
                  r.top >= top - 1 &&
                  r.bottom <= bottom + 1 &&
                  r.left >= left - 1 &&
                  r.right <= right + 1,
              };
            }),
          );
        geometry = rows;
        return rows.length === 2 && rows.every((r) => r.complete);
      },
      {
        message:
          context +
          ": complete header and at least one real row after scrolling to bottom",
      },
    )
    .toBe(true);
  console.log("ALERT_REACHABLE", context, JSON.stringify(geometry));
  await assertShellScrolling(page, context);
}
