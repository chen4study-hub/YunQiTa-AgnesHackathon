import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { realReplayFixture } from "./real-replay-fixture";

const sizes = [
  { name: "1366", width: 1366, height: 768, dpr: 1 },
  { name: "1600@1.25", width: 1600, height: 900, dpr: 1.25 },
  { name: "1920", width: 1920, height: 1080, dpr: 1 },
];
for (const size of sizes)
  test.describe(size.name, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.dpr,
      reducedMotion: "no-preference",
    });
    for (let trial = 1; trial <= 3; trial++)
      test(`smoothness trial ${trial}`, async ({ page, context }, info) => {
        await realReplayFixture(page);
        await page.route("**/api/**", (r) => r.abort());
        await page.goto("/?source=file&sceneMetrics=1&at=2026-10-12T11:25");
        const scene = page.locator(".twin-scene");
        await expect(scene).toHaveAttribute("data-scene-ready", "true", {
          timeout: 30000,
        });
        await page.waitForTimeout(2500);
        const canvas = await scene.locator("canvas").elementHandle();
        const cdp = await context.newCDPSession(page);
        const playbackTrace: unknown[] = [];
        if (process.env.SMOOTHNESS_TRACE) {
          cdp.on("Tracing.dataCollected", ({ value }) =>
            playbackTrace.push(...value),
          );
          await cdp.send("Tracing.start", {
            categories:
              "devtools.timeline,disabled-by-default-devtools.timeline",
            transferMode: "ReportEvents",
          });
        }
        if (process.env.SMOOTHNESS_PROFILE) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");
        }
        const playback = await page.evaluate(
          () =>
            new Promise<{
              maxFrameMs: number;
              intervals: number[];
              sunMaxDeg: number;
              sun: { at: number; direction: number[]; hour: number }[];
              costs: unknown[];
              longTasks: { start: number; duration: number }[];
            }>((resolve) => {
              const intervals: number[] = [],
                costs: unknown[] = [];
              const sun: { at: number; direction: number[]; hour: number }[] =
                [];
              const longTasks: { start: number; duration: number }[] = [];
              const read = () =>
                JSON.parse(
                  document.querySelector<HTMLElement>(".twin-scene")!.dataset
                    .scene!,
                );
              let start = 0,
                last = 0,
                firstFrame = 0;
              const observer = new PerformanceObserver((list) =>
                longTasks.push(
                  ...list.getEntries().map((e) => ({
                    start: e.startTime - start,
                    duration: e.duration,
                  })),
                ),
              );
              observer.observe({ type: "longtask" });
              const sampleSun = () => {
                const state = read();
                sun.push({
                  at: performance.now() - start,
                  direction: state.sunDirection,
                  hour: state.visualHour,
                });
              };
              const tick = (now: number) => {
                if (!start) {
                  start = performance.now(); // Arm before dispatch; intervals use rAF timestamps.
                  last = firstFrame = now;
                  sampleSun();
                  Array.from(
                    document.querySelectorAll<HTMLButtonElement>("button"),
                  )
                    .find((b) => b.textContent?.trim() === "▶ 播放")!
                    .click();
                  requestAnimationFrame(tick);
                  return;
                }
                if (last - firstFrame < 600) {
                  intervals.push(now - last);
                  costs.push(read().frameCost);
                }
                last = now;
                if (now - firstFrame < 600) requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
              const timer = setInterval(() => {
                if (start) sampleSun();
              }, 100);
              setTimeout(() => {
                clearInterval(timer);
                observer.disconnect();
                let sunMaxDeg = 0;
                for (let i = 1; i < sun.length; i++) {
                  const a = sun[i - 1].direction,
                    b = sun[i].direction;
                  const dot = a.reduce((s, v, j) => s + v * b[j], 0);
                  const norm = Math.hypot(...a) * Math.hypot(...b);
                  sunMaxDeg = Math.max(
                    sunMaxDeg,
                    (Math.acos(Math.max(-1, Math.min(1, dot / norm))) * 180) /
                      Math.PI,
                  );
                }
                resolve({
                  maxFrameMs: Math.max(...intervals),
                  intervals,
                  sunMaxDeg,
                  sun,
                  costs,
                  longTasks,
                });
              }, 2200);
            }),
        );
        if (process.env.SMOOTHNESS_TRACE) {
          const done = new Promise<void>((resolve) =>
            cdp.once("Tracing.tracingComplete", () => resolve()),
          );
          await cdp.send("Tracing.end");
          await done;
          writeFileSync(
            info.outputPath("playback-trace.json"),
            JSON.stringify(playbackTrace),
          );
        }
        if (process.env.SMOOTHNESS_PROFILE) {
          const { profile } = await cdp.send("Profiler.stop");
          writeFileSync(
            info.outputPath("playback.cpuprofile"),
            JSON.stringify(profile),
          );
        }
        await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
        await page
          .getByRole("button", { name: "Agent 决策", exact: false })
          .click();
        await expect(scene).toHaveAttribute("data-render-active", "false");
        await page.waitForTimeout(500);
        if (process.env.SMOOTHNESS_PROFILE) await cdp.send("Profiler.start");
        const trace: unknown[] = [];
        if (process.env.SMOOTHNESS_TRACE) {
          cdp.on("Tracing.dataCollected", ({ value }) => trace.push(...value));
          await cdp.send("Tracing.start", {
            categories:
              "devtools.timeline,disabled-by-default-devtools.timeline",
            transferMode: "ReportEvents",
          });
        }
        const returned = await page.evaluate(
          () =>
            new Promise<{
              ms: number;
              page: string | undefined;
              visible: boolean;
            }>((resolve) => {
              const start = performance.now();
              Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
                .find((b) => b.textContent?.trim().startsWith("总览"))!
                .click();
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  resolve({
                    ms: performance.now() - start,
                    page: document.querySelector<HTMLElement>("main")?.dataset
                      .page,
                    visible: !document.querySelector<HTMLElement>(
                      ".overview-persistent",
                    )?.hidden,
                  }),
                ),
              );
            }),
        );
        if (process.env.SMOOTHNESS_TRACE) {
          const done = new Promise<void>((resolve) =>
            cdp.once("Tracing.tracingComplete", () => resolve()),
          );
          await cdp.send("Tracing.end");
          await done;
          writeFileSync(
            info.outputPath("return-trace.json"),
            JSON.stringify(trace),
          );
        }
        if (process.env.SMOOTHNESS_PROFILE) {
          const { profile } = await cdp.send("Profiler.stop");
          writeFileSync(
            info.outputPath("return.cpuprofile"),
            JSON.stringify(profile),
          );
        }
        await expect(scene).toHaveAttribute("data-render-active", "true");
        expect(
          await canvas!.evaluate(
            (el) => el === document.querySelector(".twin-scene canvas"),
          ),
        ).toBe(true);
        const returnMs = returned.ms;
        const result = {
          size: size.name,
          trial,
          returnMs,
          returnState: returned,
          ...playback,
        };
        writeFileSync(
          info.outputPath("smoothness.json"),
          JSON.stringify(result),
        );
        console.log(
          "SCENE_SMOOTHNESS",
          JSON.stringify({
            size: size.name,
            trial,
            maxFrameMs: playback.maxFrameMs,
            returnMs,
            returnState: returned,
            sunMaxDeg: playback.sunMaxDeg,
          }),
        );
        expect(playback.intervals.length).toBeGreaterThan(10);
        expect(new Set(playback.sun.map((s) => s.hour)).size).toBeGreaterThan(
          15,
        );
        if (process.env.SMOOTHNESS_MEASURE_ONLY !== "1") {
          expect.soft(playback.maxFrameMs).toBeLessThanOrEqual(50);
          expect.soft(returnMs).toBeLessThanOrEqual(50);
          expect.soft(returned.page).toBe("overview");
          expect.soft(returned.visible).toBe(true);
          // Preserve the previous ~3-degree ceiling; never hide stalls with smoothing.
          expect.soft(playback.sunMaxDeg).toBeLessThanOrEqual(3);
        }
      });
  });
