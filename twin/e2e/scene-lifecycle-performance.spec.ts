import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.use({
  viewport: { width: 1366, height: 768 },
  reducedMotion: "no-preference",
});
test("scene startup, return and first continuous playback frame", async ({
  page,
  context,
}, info) => {
  page.on("pageerror", (e) => console.log("SCENE_ERROR", e.stack));
  const startupCDP = await context.newCDPSession(page);
  if (process.env.STARTUP_PROFILE) {
    await startupCDP.send("Profiler.enable");
    await startupCDP.send("Profiler.start");
  }
  await freezeTestHmr(page);
  await page.route("**/api/**", (r) => r.abort());
  await page.addInitScript(() => {
    const stats = {
      cardsMs: 0,
      sceneMs: 0,
      longTasks: [] as { start: number; duration: number }[],
    };
    (window as any).__startup = stats;
    const tasks = new PerformanceObserver((list) =>
      stats.longTasks.push(
        ...list
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration })),
      ),
    );
    tasks.observe({ type: "longtask", buffered: true });
    const observer = new MutationObserver(() => {
      if (!stats.cardsMs && document.querySelector(".overview-number"))
        stats.cardsMs = performance.now();
      if (
        !stats.sceneMs &&
        document.querySelector('[data-scene-ready="true"]')
      ) {
        stats.sceneMs = performance.now();
        stats.longTasks.push(
          ...tasks
            .takeRecords()
            .map((e) => ({ start: e.startTime, duration: e.duration })),
        );
        tasks.disconnect();
        observer.disconnect();
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-scene-ready"],
    });
  });
  await page.goto("/?source=file&sceneMetrics=1&at=2026-10-12T11:25", {
    waitUntil: "domcontentloaded",
  });
  const scene = page.locator(".twin-scene");
  await expect(scene).toHaveAttribute("data-render-active", "true", {
    timeout: 30000,
  });
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  if (process.env.STARTUP_PROFILE) {
    const { profile } = await startupCDP.send("Profiler.stop");
    writeFileSync(
      info.outputPath("startup.cpuprofile"),
      JSON.stringify(profile),
    );
    await info.attach("startup.cpuprofile", {
      body: JSON.stringify(profile),
      contentType: "application/json",
    });
  }
  await page.waitForTimeout(1500);
  const builds = await page.evaluate(() =>
    performance.getEntriesByName("twin:build").map((e) => e.duration),
  );
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  const canvas = await scene.locator("canvas").elementHandle();
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(scene).toHaveAttribute("data-render-active", "false");
  const detached = await canvas!.evaluate((el) => !el.isConnected);
  const cdp = await context.newCDPSession(page);
  if (process.env.SCENE_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  const returned = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((b) => b.textContent?.trim().startsWith("总览"))!
          .click();
        const poll = () => {
          const el = document.querySelector<HTMLElement>(".twin-scene")!;
          const state = JSON.parse(el.dataset.scene!);
          if (el.dataset.renderActive === "true" && state.renderedAt >= start)
            resolve(state.renderedAt - start);
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
  );
  if (process.env.SCENE_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    await info.attach("return.cpuprofile", {
      body: JSON.stringify(profile),
      contentType: "application/json",
    });
    const totals = new Map<string, number>();
    profile.samples?.forEach((id, i) => {
      const node = profile.nodes.find((n) => n.id === id)!;
      const key = node.callFrame.functionName + " " + node.callFrame.url;
      totals.set(
        key,
        (totals.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000,
      );
    });
    console.log(
      "RETURN_CPU",
      JSON.stringify([...totals].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    );
  }
  expect(
    await canvas!.evaluate(
      (el) => el === document.querySelector(".twin-scene canvas"),
    ),
  ).toBe(true);
  await page.waitForTimeout(500);
  const playback = await page.evaluate(
    () =>
      new Promise<{ ms: number; hours: number[] }>((resolve) => {
        const start = performance.now();
        const el = document.querySelector<HTMLElement>(".twin-scene")!;
        const initial = JSON.parse(el.dataset.scene!).visualHour;
        let first = 0;
        const hours: number[] = [];
        Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((b) => b.textContent?.trim() === "▶ 播放")!
          .click();
        const poll = () => {
          const s = JSON.parse(el.dataset.scene!);
          if (s.renderedAt >= start && s.visualHour !== initial && !first)
            first = s.renderedAt - start;
          hours.push(s.visualHour);
          if (hours.length < 25) requestAnimationFrame(poll);
          else resolve({ ms: first, hours });
        };
        requestAnimationFrame(poll);
      }),
  );
  const stages = await page.evaluate(() =>
    performance
      .getEntriesByType("measure")
      .filter((e) => e.name.startsWith("twin:"))
      .map((e) => ({ name: e.name, ms: e.duration })),
  );
  const state = JSON.parse((await scene.getAttribute("data-scene"))!);
  const result = {
    parallelCompile: state.parallelCompile,
    checkShaderErrors: state.checkShaderErrors,
    builds,
    startup: await page.evaluate(() => (window as any).__startup),
    stages,
    frameCost: state.frameCost,
    returnMs: returned,
    playbackFirstMs: playback.ms,
    detached,
    continuousSamples: new Set(playback.hours).size,
  };
  writeFileSync(
    info.outputPath("scene-lifecycle.json"),
    JSON.stringify(result),
  );
  console.log("SCENE_LIFECYCLE", JSON.stringify(result));
  await info.attach("scene-lifecycle.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(result.continuousSamples).toBeGreaterThan(15);
  if (process.env.SCENE_STARTUP_TARGETS === "1") {
    expect.soft(result.startup.cardsMs).toBeLessThanOrEqual(2000);
    expect.soft(result.startup.sceneMs).toBeLessThanOrEqual(5000);
    expect
      .soft(
        Math.max(
          0,
          ...result.startup.longTasks.map(
            (task: { duration: number }) => task.duration,
          ),
        ),
      )
      .toBeLessThanOrEqual(200);
    expect(result.checkShaderErrors).toBe(false);
  }
  if (process.env.SCENE_MEASURE_ONLY !== "1") {
    expect(builds).toHaveLength(1);
    expect(detached).toBe(true);
    expect.soft(returned).toBeLessThan(50);
    expect(playback.ms).toBeGreaterThan(0);
    expect.soft(playback.ms).toBeLessThanOrEqual(50);
  }
});

test("Agent ten-second CPU profile and hidden visibility pause", async ({
  page,
  context,
}, info) => {
  await freezeTestHmr(page);
  await page.route("**/api/**", (r) => r.abort());
  await page.addInitScript(() => {
    const original = requestAnimationFrame.bind(window);
    let count = 0;
    (window as any).__sceneCount = () => count;
    window.requestAnimationFrame = (callback) => {
      if (/composer\.render\(|scene\.project\(/.test(callback.toString()))
        count++;
      return original(callback);
    };
  });
  await page.goto("/?source=file&sceneMetrics=1&at=2026-10-12T11:25", {
    waitUntil: "domcontentloaded",
  });
  const scene = page.locator(".twin-scene");
  await expect(scene).toHaveAttribute("data-render-active", "true", {
    timeout: 30000,
  });
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.getByRole("button", { name: "Agent 决策", exact: false }).click();
  await expect(scene).toHaveAttribute("data-render-active", "false");
  await expect(page.locator("main")).toHaveAttribute("data-page", "agent");
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => (window as any).__sceneCount());
  const cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(10000);
  const { profile } = await cdp.send("Profiler.stop");
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map<number, number>();
  profile.nodes.forEach((n) =>
    n.children?.forEach((id) => parents.set(id, n.id)),
  );
  let sceneMs = 0,
    overviewMs = 0;
  profile.samples?.forEach((id, i) => {
    let core = false,
      overview = false;
    while (id) {
      const node = nodes.get(id);
      const url = node?.callFrame.url ?? "";
      if (
        /\/core\/(TwinScene|building|energy|environment)/.test(url) ||
        /TwinSceneView/.test(url)
      )
        core = true;
      if (/Overview(Page|Scene)/.test(url)) overview = true;
      id = parents.get(id) ?? 0;
    }
    const ms = (profile.timeDeltas?.[i] ?? 0) / 1000;
    if (core) sceneMs += ms;
    if (overview) overviewMs += ms;
  });
  const after = await page.evaluate(() => (window as any).__sceneCount());
  console.log(
    "SCENE_AGENT_CPU",
    JSON.stringify({ sceneMs, overviewMs, requests: after - before }),
  );
  writeFileSync(
    info.outputPath("agent-ten-seconds.cpuprofile"),
    JSON.stringify(profile),
  );
  writeFileSync(
    info.outputPath("agent-cpu.json"),
    JSON.stringify({ sceneMs, overviewMs, requests: after - before }),
  );
  await info.attach("agent-ten-seconds.cpuprofile", {
    body: JSON.stringify(profile),
    contentType: "application/json",
  });
  expect(after).toBe(before);
  expect(sceneMs).toBeLessThan(50);
  await page.getByRole("button", { name: "总览", exact: false }).click();
  await expect(scene).toHaveAttribute("data-render-active", "true");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(scene).toHaveAttribute("data-render-active", "false");
  const hiddenCount = await page.evaluate(() => (window as any).__sceneCount());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__sceneCount())).toBe(
    hiddenCount,
  );
  await page.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(scene).toHaveAttribute("data-render-active", "true");
  const times = await page.evaluate(() => ({
    scene: JSON.parse(
      document.querySelector<HTMLElement>(".twin-scene")!.dataset.scene!,
    ).visualHour,
    head: Number(
      document.querySelector<HTMLElement>(".timeline")!.dataset.headTime,
    ),
  }));
  expect(Math.abs(times.scene - times.head)).toBeLessThan(0.15);
  expect(times.scene % 1).not.toBe(0);
});
test("GPU restoration and geometry storage reuse/fallback", async ({
  page,
  context,
}, info) => {
  await freezeTestHmr(page);
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&sceneMetrics=1&at=2026-10-12T11:25", {
    waitUntil: "domcontentloaded",
  });
  const scene = page.locator(".twin-scene");
  await expect(scene).toHaveAttribute("data-render-active", "true", {
    timeout: 30000,
  });
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  await page.waitForTimeout(2500);
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  const canvas = await scene.locator("canvas").elementHandle();
  await canvas!.evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 200);
  });
  await expect
    .poll(
      async () =>
        JSON.parse((await scene.getAttribute("data-scene"))!).contextRestores,
      { timeout: 30000 },
    )
    .toBe(1);
  expect(
    await canvas!.evaluate(
      (el) => el === document.querySelector(".twin-scene canvas"),
    ),
  ).toBe(true);
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  const previous = JSON.parse((await scene.getAttribute("data-scene"))!);
  expect(previous.visualHour).toBeCloseTo(11 + 25 / 60, 4);
  await page.reload();
  await expect(scene).toHaveAttribute("data-render-active", "true", {
    timeout: 30000,
  });
  await expect(scene).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30000,
  });
  const cached = JSON.parse((await scene.getAttribute("data-scene"))!);
  const buildMs = await page.evaluate(
    () => performance.getEntriesByName("twin:build")[0].duration,
  );
  console.log(
    "SCENE_CACHED_BUILD",
    JSON.stringify({ buildMs, hits: cached.geometryCacheHits }),
  );
  expect(cached.geometryCacheHits).toBeGreaterThan(80);
  expect(cached.geometryVertices).toBe(previous.geometryVertices);
  await info.attach("cached-build.json", {
    body: JSON.stringify({ buildMs, hits: cached.geometryCacheHits }),
    contentType: "application/json",
  });
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new Error("Storage denied");
    };
  });
  await page.reload();
  await expect(scene).toHaveAttribute("data-render-active", "true", {
    timeout: 30000,
  });
  expect(
    JSON.parse((await scene.getAttribute("data-scene"))!).geometryVertices,
  ).toBe(previous.geometryVertices);
});
