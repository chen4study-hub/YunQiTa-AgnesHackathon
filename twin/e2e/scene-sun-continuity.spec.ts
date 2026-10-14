import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { realReplayFixture } from "./real-replay-fixture";

test.use({
  viewport: { width: 1920, height: 1080 },
  reducedMotion: "no-preference",
});
test("sun changes within the hour both while following now and during playback", async ({
  page,
}, info) => {
  await realReplayFixture(page);
  await page.route("**/api/**", (r) => r.abort());
  // Keep a running clock, not ?at (which intentionally fixes the current time).
  await page.clock.setSystemTime(new Date(2026, 9, 12, 11, 25));
  await page.goto("/?source=file&sceneMetrics=1");
  await expect(page.locator(".twin-scene")).toHaveAttribute(
    "data-scene-ready",
    "true",
    { timeout: 30000 },
  );
  const sample = () =>
    page.evaluate(async () => {
      const samples: { at: number; hour: number; sun: number[] }[] = [];
      const start = performance.now();
      for (let i = 0; i < 4; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1000));
        const state = JSON.parse(
          document.querySelector<HTMLElement>(".twin-scene")!.dataset.scene!,
        );
        samples.push({
          at: performance.now() - start,
          hour: state.visualHour,
          sun: state.sunDirection,
        });
      }
      return samples;
    });
  const following = await sample();
  expect(new Set(following.map((s) => Math.floor(s.hour))).size).toBe(1);
  expect(new Set(following.map((s) => s.sun.join(","))).size).toBe(4);
  for (let i = 1; i < following.length; i++)
    expect(following[i].hour).toBeGreaterThan(following[i - 1].hour);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  const playing = await sample();
  expect(new Set(playing.map((s) => s.sun.join(","))).size).toBe(4);
  const withinHour = await page.evaluate(async () => {
    const samples: { hour: number; sun: number[] }[] = [];
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const state = JSON.parse(
        document.querySelector<HTMLElement>(".twin-scene")!.dataset.scene!,
      );
      samples.push({ hour: state.visualHour, sun: state.sunDirection });
    }
    return samples;
  });
  const sameHour = withinHour.filter(
    (s) => Math.floor(s.hour) === Math.floor(withinHour[0].hour),
  );
  expect(sameHour.length).toBeGreaterThan(1);
  expect(new Set(sameHour.map((s) => s.sun.join(","))).size).toBe(
    sameHour.length,
  );
  for (const s of [...following, ...playing, ...withinHour]) {
    const hour = ((s.hour % 24) + 24) % 24;
    expect(s.sun[0]).toBeCloseTo(
      Math.cos(((hour - 6) / 12) * Math.PI) * 100,
      7,
    );
  }
  writeFileSync(
    info.outputPath("sun-continuity.json"),
    JSON.stringify({ following, playing, withinHour }),
  );
  console.log(
    "SUN_CONTINUITY",
    JSON.stringify({ following, playing, withinHour }),
  );
});
