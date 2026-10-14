import { test, expect, type Page } from "@playwright/test";

test.setTimeout(60000);
const deferredPages = [
  {
    id: "forecast",
    module: "ForecastPage",
    key: ".forecast-page h2",
    text: "24 小时负荷预测",
  },
  {
    id: "agent",
    module: "AgentPage",
    key: ".agent-root h2",
    text: "Agent 调度决策",
  },
  {
    id: "floors",
    module: "FloorsPage",
    key: ".floors-page select[aria-label='选择楼层']",
  },
  {
    id: "energy",
    module: "EnergyPage",
    key: ".energy-end-use h2",
    text: "分项能耗",
  },
  {
    id: "about",
    module: "AboutPage",
    key: ".about-page h1",
    text: "一栋塔楼，一个能源决策闭环",
  },
] as const;
const pageModule =
  /\/src\/pages\/(OverviewPage|ForecastPage|AgentPage|FloorsPage|EnergyPage|AboutPage)\.tsx(?:\?|$)/;
const delayMs = 900;
// 5191 / Edge / one worker: five warm entries measured 83–438ms;
// under concurrent CPU load Forecast repeated at 587–607ms. 750ms leaves
// ~140ms scheduling headroom but remains below the 900ms cold module delay.
const warmEntryBudgetMs = 750;

async function openOverview(page: Page) {
  // Freeze HMR messages for this browser only: other sessions may save src
  // mid-measurement. Module requests still go to the real Vite server.
  await page.routeWebSocket(
    (url) =>
      url.hostname === "127.0.0.1" &&
      url.port === String(process.env.PLAYWRIGHT_PORT ?? 5173),
    (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          const type = JSON.parse(message).type;
          if (["update", "full-reload", "prune"].includes(type)) return;
        }
        socket.send(message);
      });
    },
  );
  // Offline shell contract: do not depend on or disturb the resident backend.
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
    timeout: 15000,
  });
  await expect(page.locator("main")).toHaveAttribute("data-page", "overview");
  await expect(page.locator(".overview-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".twin-scene canvas")).toBeVisible({
    timeout: 15000,
  });
  await page.evaluate(() => document.fonts.ready);
}

type PaintProbe = {
  frames: number;
  blankFrames: { at: number; route?: string }[];
  elapsedMs: number;
  targetVisibleMs: number | null;
  done: boolean;
};
async function armClickProbe(page: Page, id: string, key: string) {
  await page.evaluate(
    ({ id, key }) => {
      const main = document.querySelector<HTMLElement>("main")!;
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect(),
          a = main.getBoundingClientRect();
        if (
          !r.width ||
          !r.height ||
          r.right <= a.left ||
          r.left >= a.right ||
          r.bottom <= a.top ||
          r.top >= a.bottom
        )
          return false;
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = getComputedStyle(n);
          if (
            c.display === "none" ||
            c.visibility !== "visible" ||
            Number(c.opacity) === 0
          )
            return false;
        }
        return true;
      };
      const probe: PaintProbe = {
        frames: 0,
        blankFrames: [],
        elapsedMs: 0,
        targetVisibleMs: null,
        done: false,
      };
      (
        window as typeof window & { lazyPaintProbe: PaintProbe }
      ).lazyPaintProbe = probe;
      document.addEventListener(
        "click",
        function start(event) {
          if (
            !(event.target instanceof Element) ||
            event.target
              .closest("[data-page-link]")
              ?.getAttribute("data-page-link") !== id
          )
            return;
          document.removeEventListener("click", start, true);
          const started = performance.now();
          const sample = () => {
            probe.elapsedMs = performance.now() - started;
            probe.frames++;
            // Empty wrappers do not count: require visible text, graphics or a skeleton.
            const painted = [...main.querySelectorAll("*")].some(
              (el) =>
                visible(el) &&
                (el.matches(
                  "canvas,img,svg,input,select,textarea,[role='progressbar'],.skeleton,[data-skeleton]",
                ) ||
                  [...el.childNodes].some(
                    (n) =>
                      n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
                  )),
            );
            if (!painted)
              probe.blankFrames.push({
                at: probe.elapsedMs,
                route: main.dataset.page,
              });
            const target = main.querySelector(key);
            if (
              probe.targetVisibleMs === null &&
              main.dataset.page === id &&
              target &&
              visible(target)
            )
              probe.targetVisibleMs = probe.elapsedMs;
            // At least 1.5 seconds, and include the eventual new-page commit.
            if (probe.elapsedMs >= 1500 && probe.targetVisibleMs !== null)
              probe.done = true;
            else requestAnimationFrame(sample);
          };
          sample();
        },
        true,
      );
    },
    { id, key },
  );
}
async function collectProbe(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as typeof window & { lazyPaintProbe: PaintProbe })
              .lazyPaintProbe.done,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (window as typeof window & { lazyPaintProbe: PaintProbe }).lazyPaintProbe,
  );
}

test("initial overview does not request any of the five lazy page modules", async ({
  page,
}) => {
  const modules: string[] = [];
  page.on("request", (r) => {
    const match = r.url().match(pageModule);
    if (match) modules.push(match[1]);
  });
  await openOverview(page);
  // Do not move the mouse or focus navigation: either would cause intent prefetch.
  await page.waitForTimeout(1500);
  expect(modules).toContain("OverviewPage");
  expect(modules.filter((m) => m !== "OverviewPage")).toEqual([]);
  for (const target of deferredPages)
    expect(modules, target.module).not.toContain(target.module);
});
for (const target of deferredPages)
  test(`${target.module}: delayed first entry stays painted and second entry reuses the module`, async ({
    page,
  }, testInfo) => {
    const requests: string[] = [],
      delays: number[] = [],
      errors: string[] = [];
    let documents = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame())
        documents++;
      if (r.url().match(pageModule)?.[1] === target.module)
        requests.push(r.url());
    });
    await page.route(
      new RegExp(`/src/pages/${target.module}\\.tsx(?:\\?|$)`),
      async (route) => {
        const start = performance.now();
        // Node timers can fire a fraction early; inject the promised delay
        // rather than relaxing either cold timing or the 750ms warm budget.
        while (performance.now() - start < delayMs)
          await new Promise((r) =>
            setTimeout(r, Math.ceil(delayMs - (performance.now() - start))),
          );
        delays.push(performance.now() - start);
        await route.continue();
      },
    );
    await openOverview(page);
    expect(requests).toEqual([]);
    const nav = page.locator(`[data-page-link="${target.id}"]`);
    // Arm before pointer movement; sampling starts at the real capture-phase click.
    await armClickProbe(page, target.id, target.key);
    await nav.click();
    const cold = await collectProbe(page);
    await expect(page.locator("main")).toHaveAttribute("data-page", target.id);
    await expect(page.locator(target.key).first()).toBeVisible();
    if ("text" in target)
      await expect(page.locator(target.key).first()).toHaveText(target.text);
    await testInfo.attach("cold-entry", {
      body: JSON.stringify({ cold, delays, requests }),
      contentType: "application/json",
    });
    expect(requests).toHaveLength(1);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(delayMs);
    expect(cold.elapsedMs).toBeGreaterThanOrEqual(1500);
    // Every delivered rAF is checked; this is not an FPS benchmark on a shared CPU.
    expect(cold.frames).toBeGreaterThan(1);
    expect(cold.blankFrames).toEqual([]);
    expect(cold.targetVisibleMs).not.toBeNull();
    await page.locator('[data-page-link="overview"]').click();
    await expect(page.locator("main")).toHaveAttribute("data-page", "overview");
    await expect(page.locator(".overview-grid")).toBeVisible();
    const before = requests.length;
    await armClickProbe(page, target.id, target.key);
    await nav.click();
    const warm = await collectProbe(page);
    await expect(page.locator("main")).toHaveAttribute("data-page", target.id);
    await expect(page.locator(target.key).first()).toBeVisible();
    await testInfo.attach("warm-entry", {
      body: JSON.stringify({ warm, requests }),
      contentType: "application/json",
    });
    expect(requests).toHaveLength(before);
    expect(delays).toHaveLength(1);
    expect(warm.blankFrames).toEqual([]);
    expect(warm.targetVisibleMs).not.toBeNull();
    expect(warm.targetVisibleMs!).toBeLessThan(warmEntryBudgetMs);
    expect(documents).toBe(1);
    expect(errors).toEqual([]);
  });
