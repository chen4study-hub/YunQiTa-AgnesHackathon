import { expect, type Page } from "@playwright/test";

/** Serialize this standalone function for both one-shot and per-rAF shell audits. */
export function inspectShellScrolling() {
  const failures: {
    class: string;
    axis: string;
    excess: number;
    reason: string;
  }[] = [];
  const main = document.querySelector<HTMLElement>("main");
  if (!main)
    return [{ class: "main", axis: "y", excess: 0, reason: "missing main" }];
  if (document.documentElement.scrollWidth > innerWidth)
    failures.push({
      class: "document",
      axis: "x",
      excess: document.documentElement.scrollWidth - innerWidth,
      reason: "horizontal overflow",
    });
  const growing =
    '[data-scroll-region],ul,ol,table,[role="log"],[role="list"],[role="region"],.agent-chat-messages,.agent-plan-column,.agent-steps,.agent-receipt,.forecast-model-scroll';
  for (const el of [main, ...main.querySelectorAll<HTMLElement>("*")]) {
    if (
      !el.clientWidth ||
      !el.clientHeight ||
      !el.checkVisibility({ checkVisibilityCSS: true })
    )
      continue;
    const css = getComputedStyle(el),
      dx = el.scrollWidth - el.clientWidth,
      dy = el.scrollHeight - el.clientHeight;
    const scrollingY = ["auto", "scroll"].includes(css.overflowY);
    // A table may scroll inside its own bounded container, never main/the page.
    const horizontal = ["auto", "scroll"].includes(css.overflowX);
    const table = el.querySelector('table,[role="table"],[role="grid"]');
    const r = el.getBoundingClientRect(),
      m = main.getBoundingClientRect();
    const boundedTable =
      el !== main &&
      !!table &&
      horizontal &&
      r.left >= m.left - 1 &&
      r.right <= m.right + 1;
    if (dx > 1 && (el === main || horizontal) && !boundedTable)
      failures.push({
        class: el.className,
        axis: "x",
        excess: dx,
        reason: "horizontal overflow",
      });
    // A 1–7px scrollbar is decorative/layout noise, not useful growing content.
    if (scrollingY && dy > 0 && dy < 8)
      failures.push({
        class: el.className,
        axis: "y",
        excess: dy,
        reason: "vertical scrollbar for less than 8px overflow",
      });
    if (horizontal && dx > 0 && dx < 8)
      failures.push({
        class: el.className,
        axis: "x",
        excess: dx,
        reason: "horizontal scrollbar for less than 8px overflow",
      });
    if (css.overflowY === "scroll" && dy <= 1)
      failures.push({
        class: el.className,
        axis: "y",
        excess: dy,
        reason: "scrollbar although content fits",
      });
    if (
      scrollingY &&
      dy > 1 &&
      el !== main &&
      !el.matches(growing) &&
      !el.querySelector(growing)
    )
      failures.push({
        class: el.className,
        axis: "y",
        excess: dy,
        reason: "not main or growing list/records",
      });
    if (el === main && dy > 1 && !scrollingY && css.overflowY !== "visible")
      failures.push({
        class: el.className,
        axis: "y",
        excess: dy,
        reason: "main content clipped instead of scrollable",
      });
  }
  return failures;
}
export async function assertShellScrolling(page: Page, context: string) {
  expect(await page.evaluate(inspectShellScrolling), context).toEqual([]);
}
export async function installScrollInspector(page: Page) {
  await page.evaluate(
    `window.__inspectShellScrolling = ${inspectShellScrolling.toString()}`,
  );
}

/** Isolate only this test page from concurrent Vite hot updates, not module loading. */
export async function freezeTestHmr(page: Page) {
  await page.routeWebSocket(
    (url) =>
      url.hostname === "127.0.0.1" &&
      url.port === String(process.env.PLAYWRIGHT_PORT ?? 5173),
    (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (
          typeof message === "string" &&
          ["update", "full-reload", "prune"].includes(JSON.parse(message).type)
        )
          return;
        socket.send(message);
      });
    },
  );
}
