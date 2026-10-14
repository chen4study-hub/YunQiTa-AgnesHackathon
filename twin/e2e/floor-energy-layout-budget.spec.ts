import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { isolateOpsTest, opsDay } from "./ops-test-data";
import { evaluateOpsSnapshot } from "../src/data/ops/elevator";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";

for (const size of [
  { width: 1366, height: 768, min: 120, max: 160 },
  { ...DESKTOP_125, min: 140, max: 200 },
  { width: 1920, height: 1080, min: 150, max: 260 },
  { width: 390, height: 844, min: 240, max: 260 },
])
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`layout budget / numaudit ${size.width}`, async ({ page }, info) => {
    test.setTimeout(90000);
    await freezeTestHmr(page);
    await isolateOpsTest(page);
    await page.setViewportSize(size);
    await page.goto("/?source=file&at=2026-10-12T14:00", {
      waitUntil: "domcontentloaded",
    });
    for (const [name, selector] of [
      ["楼层与电梯", ".floors-page"],
      ["能源与告警", ".energy-page"],
    ]) {
      await page.getByRole("button", { name }).click();
      const root = page.locator(selector);
      await expect(root).toHaveAttribute("data-time", "14");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const geometry = await root.evaluate((root) => {
        const rect = (selector: string) =>
          root.querySelector(selector)?.getBoundingClientRect().toJSON();
        const main = document.querySelector("main")!;
        function selectorForFloors(root: Element) {
          return Array.from(
            root.querySelectorAll(
              ".floors-detail-card > *, .floors-load-chart, .floors-lift-shafts, .floors-elevators-card > *",
            ),
          ).map((e) => ({
            cls: e.className,
            height: e.getBoundingClientRect().height,
            width: e.getBoundingClientRect().width,
            top: e.getBoundingClientRect().top,
            bottom: e.getBoundingClientRect().bottom,
            excess: e.scrollHeight - e.clientHeight,
          }));
        }
        return {
          page: root.getBoundingClientRect().toJSON(),
          main: main.getBoundingClientRect().toJSON(),
          excess: root.scrollHeight - root.clientHeight,
          mainExcess: main.scrollHeight - main.clientHeight,
          dx: root.scrollWidth - root.clientWidth,
          donut: rect(".energy-donut"),
          legend: rect(".energy-use-legend"),
          header: rect(".energy-alert-table thead"),
          body: parseFloat(getComputedStyle(root).fontSize),
          cards: Array.from(root.children).map((e) => ({
            cls: e.className,
            ...e.getBoundingClientRect().toJSON(),
          })),
          cumulative: Array.from(
            root.querySelectorAll(".energy-cumulative > div"),
          ).map((e) => e.getBoundingClientRect().toJSON()),
          metrics: Array.from(
            root.querySelectorAll(
              ".floors-metrics b,.energy-cumulative b,.energy-environment-metrics b,.energy-ems-totals b",
            ),
          ).map((b) => {
            const n = b.querySelector("span")!,
              u = b.querySelector("small")!;
            const nr = n.getBoundingClientRect(),
              ur = u.getBoundingClientRect();
            return {
              size: parseFloat(getComputedStyle(n).fontSize),
              ratio:
                parseFloat(getComputedStyle(u).fontSize) /
                parseFloat(getComputedStyle(n).fontSize),
              text: b.textContent,
              unit: u.textContent,
              numberText: n.textContent,
              sameLine: ur.top < nr.bottom && ur.bottom > nr.top,
              percent: u.textContent === "%",
              gap: ur.left - nr.right,
              dx: b.scrollWidth - b.clientWidth,
            };
          }),
          floorLayout: selectorForFloors(root),
          clipped: Array.from(root.querySelectorAll("section"))
            .filter((e) => e.scrollHeight > e.clientHeight + 3)
            .map((e) => e.className),
        };
      });
      console.log(
        size.width,
        name,
        JSON.stringify({
          pageOverflow: geometry.excess,
          horizontal: geometry.dx,
          body: geometry.body,
          header: geometry.header,
          metrics: geometry.metrics,
          floorLayout: geometry.floorLayout,
        }),
      );
      expect(geometry.dx).toBeLessThanOrEqual(1);
      expect(geometry.body).toBe(size.width >= 1600 ? 15 : 14);
      expect(geometry.clipped).toEqual([]);
      if (size.width === 1920) {
        expect(geometry.excess).toBeLessThanOrEqual(1);
        expect(geometry.mainExcess).toBeLessThanOrEqual(1);
      }
      for (const m of geometry.metrics) {
        expect(m.size).toBeGreaterThanOrEqual(24);
        expect(m.ratio).toBeGreaterThanOrEqual(0.4);
        expect(m.ratio).toBeLessThanOrEqual(0.5);
        expect(m.sameLine).toBe(true);
        // Percentages remain adjacent; other units require a real text separator.
        if (m.percent) {
          expect(m.text).toBe(`${m.numberText}%`);
          expect(Math.abs(m.gap)).toBeLessThanOrEqual(1);
        } else {
          expect(m.unit).toMatch(/^[  ][^  ]/);
          expect(m.text?.replace(/ /g, " ")).toBe(`${m.numberText} ${m.unit?.slice(1)}`);
        }
        expect(m.dx).toBeLessThanOrEqual(1);
      }
      if (name === "楼层与电梯" && size.width > 640) {
        // Natural main vertical flow is allowed; clipping/false bars remain errors.
        await assertShellScrolling(page, `floors natural flow ${size.width}`);
        const load = root.locator(".floors-load-chart");
        await expect(load).toHaveAttribute("data-bar-count", "40");
        const fill = await load.evaluate((e) => {
          const parent = e.parentElement!;
          return {
            height: e.clientHeight,
            parent: parent.clientHeight,
            stride: Number((e as HTMLElement).dataset.labelStride),
          };
        });
        expect(fill.height).toBeCloseTo(fill.parent, 0);
        expect(fill.stride).toBeLessThanOrEqual(2);
        const lifts = await root
          .locator(".floors-lift-column")
          .evaluateAll((es) =>
            es.map((e) => {
              const r = e.getBoundingClientRect(),
                shaft = e.querySelector(".floors-lift-shaft")!;
              return {
                top: r.top,
                bottom: r.bottom,
                excess: e.scrollHeight - e.clientHeight,
                height: shaft.getBoundingClientRect().height,
                shaftExcess: shaft.scrollHeight - shaft.clientHeight,
              };
            }),
          );
        expect(lifts).toHaveLength(6);
        for (const lift of lifts) {
          expect(lift.bottom).toBeLessThanOrEqual(geometry.page.bottom + 1);
          expect(lift.excess).toBeLessThanOrEqual(2);
          expect(lift.height).toBeGreaterThanOrEqual(100);
        }
        const table = root.locator(".floors-lift-table-scroll");
        await table.evaluate((e) => {
          e.scrollTop = e.scrollHeight;
        });
        await table.locator("tbody tr").last().scrollIntoViewIfNeeded();
        await expect(table.locator("tbody tr").last()).toBeInViewport();
        await table.evaluate((e) => {
          e.scrollTop = 0;
        });
      }
      if (name === "能源与告警") {
        expect(geometry.donut!.right).toBeLessThanOrEqual(
          geometry.legend!.left,
        );
        // Alert headers may start below the fold, but must be scroll-reachable.
        const header = root.locator(".energy-alert-table thead");
        await header.scrollIntoViewIfNeeded();
        await expect(header).toBeInViewport();
        await assertShellScrolling(page, `energy natural flow ${size.width}`);
        const cols = new Set(geometry.cumulative.map((r) => Math.round(r.x)))
          .size;
        expect(cols).toBe(size.width === 1920 ? 4 : 2);
        const soc = await root
          .locator(".energy-soc-reading b")
          .evaluate((b) => {
            const n = b.querySelector("span")!.getBoundingClientRect(),
              u = b.querySelector("small")!.getBoundingClientRect();
            return {
              text: b.textContent,
              numberText: b.querySelector("span")!.textContent,
              gap: u.left - n.right,
              sameLine: u.top < n.bottom && u.bottom > n.top,
            };
          });
        expect(soc.text).toBe(`${soc.numberText}%`);
        expect(Math.abs(soc.gap)).toBeLessThanOrEqual(1);
        expect(soc.sameLine).toBe(true);
        const radii = await root.locator(".energy-soc").evaluate((host) => {
          const svg = host.querySelector<SVGSVGElement>("svg")!,
            inverse = svg.getScreenCTM()!.inverse();
          const reading = host.querySelector<HTMLElement>("b")!,
            n = reading.querySelector("span")!;
          const original = n.textContent;
          const values = [original!, "35.0", "100.0"].map((value) => {
            n.textContent = value;
            const r = reading.getBoundingClientRect();
            return Math.max(
              ...[r.left, r.right].flatMap((x) =>
                [r.top, r.bottom].map((y) => {
                  const p = new DOMPoint(x, y).matrixTransform(inverse);
                  return Math.hypot(p.x - 60, p.y - 54);
                }),
              ),
            );
          });
          n.textContent = original;
          return values;
        });
        for (const radius of radii) expect(radius).toBeLessThanOrEqual(37.5);
        const bodies = await root
          .locator(".energy-use-legend li,.energy-power-row > span")
          .evaluateAll((es) =>
            es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
          );
        for (const sizePx of bodies)
          expect(sizePx).toBe(size.width >= 1600 ? 15 : 14);
        await expect(root.locator(".energy-cumulative > div")).toHaveCount(4);
        for (const chart of await root.locator(".energy-timeseries").all()) {
          const box = (await chart.boundingBox())!;
          // 6c5f630: 214px Cartesian grid floor (74px axes + 140px plot).
          // Assert exact natural-layout height, not the old compressed-card ceiling.
          expect(box.height).toBeCloseTo(size.width <= 640 ? 240 : size.width >= 1800 ? 220 : 214, 0);
        }
      }
      await page.screenshot({
        path: info.outputPath(`${selector.slice(1)}-${size.width}.png`),
      });
    }
  });
  });

test("ops high-zone masks preserve 2–20F pass-through and lobby-only low-zone stops", async ({
  page,
}) => {
  await isolateOpsTest(page);
  await freezeTestHmr(page);
  const day = opsDay("2026-10-12");
  const high = day.elevators.filter((lift) => lift.zone === "high");
  expect(high).toHaveLength(3);
  for (const lift of high) {
    expect(lift.trips.some((t) => t.from_floor === 1 || t.to_floor === 1)).toBe(
      true,
    );
    for (const trip of lift.trips) {
      for (const offset of [
        trip.depart_ms,
        (trip.depart_ms + trip.arrive_ms) / 2,
        trip.arrive_ms,
        trip.arrive_ms + trip.dwell_ms - 1,
      ]) {
        const s = evaluateOpsSnapshot(
          day,
          day.day_start_ms + offset,
        ).elevators.find((s) => s.id === lift.id)!;
        if (s.status === "idle" || s.status === "doors")
          expect(s.floor === 1 || s.floor >= 21).toBe(true);
        else if (s.floor >= 2 && s.floor <= 20)
          expect(["up", "down"]).toContain(s.status);
      }
    }
  }
  await page.goto("/?source=file&at=2026-10-12T14:00", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "楼层与电梯" }).click();
  const shafts = page.locator(".floors-lift-shaft.floors-high");
  await expect(shafts).toHaveCount(3, { timeout: 15000 });
  const masks = await shafts.evaluateAll((es) =>
    es.map((shaft) => {
      const car = shaft.querySelector<HTMLElement>(".floors-lift-car")!,
        mask = shaft.querySelector<HTMLElement>(".floors-unserved")!;
      const sr = shaft.getBoundingClientRect(),
        mr = mask.getBoundingClientRect(),
        travel = shaft.clientHeight - car.getBoundingClientRect().height;
      return {
        label: mask.getAttribute("aria-label"),
        bottom: sr.bottom - mr.bottom,
        top: sr.bottom - mr.top,
        expectedBottom: travel / 39,
        expectedTop: (travel * 20) / 39,
        carZ: Number(getComputedStyle(car).zIndex),
        maskZ: Number(getComputedStyle(mask).zIndex),
        gray: getComputedStyle(mask).backgroundImage,
      };
    }),
  );
  for (const m of masks) {
    expect(m.label).toBe("2至20F不停靠，仅穿越");
    expect(m.bottom).toBeCloseTo(m.expectedBottom, 0);
    expect(m.top).toBeCloseTo(m.expectedTop, 0);
    expect(m.carZ).toBeGreaterThan(m.maskZ);
    expect(m.gray).toContain("repeating-linear-gradient");
  }
});
