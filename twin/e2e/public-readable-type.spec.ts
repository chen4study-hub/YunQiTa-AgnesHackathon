import { DESKTOP_125 } from "./viewport-profile";
import { test, expect, type Page } from "@playwright/test";
import { assertShellScrolling } from "./shell-scroll-policy";

const sizes = [
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
  { width: 390, height: 844 },
];
async function textMetrics(page: Page, selector: string) {
  return page.locator(selector).evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const result: {
      text: string;
      size: number;
      role: string;
      required: number;
    }[] = [];
    const nodes: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node);
    for (const node of nodes) {
      const text = node.textContent?.trim(),
        el = node.parentElement!;
      if (!text || el.closest("script,style,svg,.echart,.chart-tooltip"))
        continue;
      const css = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(node);
      if (
        !el.checkVisibility() ||
        ![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)
      )
        continue;
      let role = "body",
        token = "--font-body";
      if (
        el.closest(
          ".scene-labels,.scene-legend,.timeline,.time-legend,.nav-item small",
        )
      ) {
        role = "label";
        token = "--font-label";
      } else if (
        el.closest("h1,h2,.scene-heading,.overview-metric > small") &&
        !el.closest(".scene-heading small")
      ) {
        role = "title";
        token = "--font-title";
      } else if (
        el.closest(
          "small,dt,figcaption,.credit,.top-badge,.dispatch-note,.model-version,.about-rate-row b",
        )
      ) {
        role = "note";
        token = "--font-note";
      } else if (
        el.closest(".about-metrics span,.about-rate-row span,.type-unit")
      ) {
        role = "label";
        token = "--font-label";
      }
      // Resolve clamp tokens through a temporary probe, not parseFloat('clamp(...)').
      const probe = document.createElement("span");
      probe.style.fontSize = `var(${token})`;
      root.appendChild(probe);
      const required = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      result.push({ text, size: parseFloat(css.fontSize), role, required });
    }
    return result;
  });
}
for (const size of sizes)
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`public readable typography and intrinsic layout ${size.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize(size);
    await page.route("**/api/**", (r) => r.abort());
    await page.goto("/?source=file&at=2026-10-12T18:31", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".overview-metric")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const tokens = await page.evaluate(() =>
      Object.fromEntries(
        ["body", "table", "note", "label", "legend"].map((name) => [
          name,
          getComputedStyle(document.documentElement)
            .getPropertyValue(`--font-${name}`)
            .trim(),
        ]),
      ),
    );
    expect(tokens).toEqual({
      body: size.width <= 1366 ? "14px" : "15px",
      table: "14px",
      note: "14px",
      label: "12px",
      legend: "12px",
    });
    for (const scope of [".topbar", ".bottombar", ".overview-grid"]) {
      const samples = await textMetrics(page, scope);
      expect(samples.length, scope).toBeGreaterThan(5);
      const tooSmall = samples.filter((x) => x.size + 0.01 < x.required);
      expect(tooSmall, `${scope} undersized visible text`).toEqual([]);
      console.log(
        size.width,
        scope,
        "minimum",
        Math.min(...samples.map((x) => x.size)),
        "tiers",
        Object.fromEntries(
          ["body", "note", "label", "title"].map((role) => [
            role,
            Math.min(
              ...samples.filter((x) => x.role === role).map((x) => x.size),
            ),
          ]),
        ),
      );
    }
    const overview = await page.locator(".overview-grid").evaluate((root) => ({
      cards: [...root.querySelectorAll<HTMLElement>(".card")].map((el) => ({
        name: el.className,
        overflow: getComputedStyle(el).overflowY,
        clip: el.scrollHeight > el.clientHeight + 1,
      })),
      main: {
        client: document.querySelector("main")!.clientHeight,
        scroll: document.querySelector("main")!.scrollHeight,
        overflow: getComputedStyle(document.querySelector("main")!).overflowY,
      },
    }));
    expect(
      overview.cards.filter((c) => c.clip || /auto|scroll/.test(c.overflow)),
    ).toEqual([]);
    if (overview.main.scroll > overview.main.client)
      expect(overview.main.overflow).toBe("auto");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(size.width);
    await page.screenshot({
      path: info.outputPath("overview.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-page")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const samples = await textMetrics(page, ".about-page");
    expect(samples.filter((x) => x.size + 0.01 < x.required)).toEqual([]);
    console.log(
      size.width,
      "About minimum",
      Math.min(...samples.map((x) => x.size)),
    );
    const about = await page.locator(".about-page").evaluate((root) => {
      const main = document.querySelector("main")!;
      const rect = root.getBoundingClientRect(),
        mr = main.getBoundingClientRect();
      const access = [...root.querySelectorAll(".about-access-notes p")].map(
        (el) => {
          const text = el.firstChild!;
          const lines = new Map<number, string>();
          for (let i = 0; i < text.textContent!.length; i++) {
            const r = document.createRange();
            r.setStart(text, i);
            r.setEnd(text, i + 1);
            const top = Math.round(r.getBoundingClientRect().top);
            lines.set(top, (lines.get(top) ?? "") + text.textContent![i]);
          }
          return [...lines.values()];
        },
      );
      return {
        height: rect.height,
        available: main.clientHeight,
        scroll: main.scrollHeight,
        bottom: rect.bottom - mr.top,
        access,
        cards: [...root.querySelectorAll<HTMLElement>(".card")].map((el) => ({
          name: el.className,
          overflow: getComputedStyle(el).overflowY,
          clip: el.scrollHeight > el.clientHeight + 1,
        })),
      };
    });
    console.log(size.width, JSON.stringify(about));
    expect(
      about.cards.filter((c) => c.clip || /auto|scroll/.test(c.overflow)),
    ).toEqual([]);
    for (const lines of about.access)
      if (lines.length > 1)
        expect(lines.at(-1)!.trim().length).toBeGreaterThan(2);
    // Font floors take priority at every width; main may scroll, cards may not clip.
    await assertShellScrolling(page, `About intrinsic typography ${size.width}`);
    if (size.width > 1180 && about.height <= about.available)
      expect(about.scroll).toBe(about.available);
    if (about.height > about.available) {
      await page
        .locator("main")
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      expect(
        await page.locator("main").evaluate((el) => el.scrollTop),
      ).toBeGreaterThan(0);
      await page.screenshot({
        path: info.outputPath("about-bottom.png"),
        animations: "disabled",
      });
      await page.locator("main").evaluate((el) => (el.scrollTop = 0));
    }
    await page.screenshot({
      path: info.outputPath("about.png"),
      animations: "disabled",
    });
  });
  });

test("390 midnight keeps 12px date in its own row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2026-10-12T23:59:58+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T23:59:58+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file");
  const date = page.locator(".timeline-date-label");
  await expect(date).toHaveText("10-12");
  await page.clock.fastForward(3000);
  await expect(date).toHaveText("10-13");
  expect(
    await date.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(12);
  const dr = (await date.boundingBox())!;
  for (const label of await page.locator(".mobile-hour-label").all()) {
    const hr = (await label.boundingBox())!;
    expect(dr.y).toBeGreaterThanOrEqual(hr.y + hr.height);
  }
  const axis = (await page.locator(".timeline").boundingBox())!;
  expect(dr.x + dr.width).toBeLessThanOrEqual(axis.x + axis.width);
});
