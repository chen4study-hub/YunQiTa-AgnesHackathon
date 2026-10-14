import { test, expect } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
test("real current_energy answer updates a single waiting node in place", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  test.skip(
    process.env.AGENT_PROGRESS_LIVE !== "1",
    "Opt in real /chat/stream",
  );
  await page.addInitScript(() => {
    const state = {
      events: [] as any[],
      samples: [] as { count: number; id: number; text: string }[],
      nodes: new WeakMap<Node, number>(),
      sequence: 0,
      requestAt: null as number | null,
      firstDeltaAt: null as number | null,
      arrivals: [] as { type: string; tool?: string; elapsedMs: number; event: any }[],
      complete: false,
    };
    (window as any).waitingProbe = state;
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const isChat = String(args[0]).endsWith("/chat/stream");
      if (isChat) state.requestAt = performance.now();
      const response = await fetch(...args);
      if (!isChat) return response;
      void (async () => {
        const reader = response.clone().body!.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line.startsWith("data:")) {
              try {
                const event = JSON.parse(line.slice(5));
                const now = performance.now();
                // Request dispatch -> first answer_delta, including tool work
                // and any admission/classification delay before SSE events.
                if (event.type === "answer_delta") state.firstDeltaAt ??= now;
                state.arrivals.push({
                  type: event.type, tool: event.tool,
                  elapsedMs: now - state.requestAt!, event,
                });
                state.events.push(event);
              } catch {}
            }
          }
          if (chunk.done) { state.complete = true; break; }
        }
      })();
      return response;
    };
    window.addEventListener("DOMContentLoaded", () =>
      new MutationObserver(() => {
        const rows = [
          ...document.querySelectorAll('[data-progress-id="chat-answer-wait"]'),
        ];
        const node = rows[0];
        if (node && !state.nodes.has(node))
          state.nodes.set(node, ++state.sequence);
        if (node)
          state.samples.push({
            count: rows.length,
            id: state.nodes.get(node)!,
            text: node.textContent ?? "",
          });
      }).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      }),
    );
  });
  // Only the chat is exercised against the real backend; avoid an unrelated schedule mutation.
  await page.route("**/api/schedule", (r) => r.abort());
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00&api=/api");
  await page.getByRole("button", { name: "Agent 决策" }).click();
  await page
    .getByRole("textbox", { name: "运维问题" })
    .fill("现在光伏发电多少");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-answer-text").last()).not.toBeEmpty({
    timeout: 75000,
  });
  await expect(page.getByRole("textbox", { name: "运维问题" })).toBeEnabled({
    timeout: 75000,
  });
  await expect(
    page.locator('[data-progress-id="chat-answer-wait"]'),
  ).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).waitingProbe.complete)).toBe(true);
  const probe = await page.evaluate(() => {
    const s = (window as any).waitingProbe;
    return {
      events: s.events, samples: s.samples,
      requestAt: s.requestAt, firstDeltaAt: s.firstDeltaAt,
      arrivals: s.arrivals,
    };
  });
  await info.attach("live-wait-evidence", {
    body: JSON.stringify(probe, null, 2),
    contentType: "application/json",
  });
  const waits = probe.events.filter(
    (e: any) => e.type === "progress" && e.id === "chat-answer-wait",
  );
  expect(probe.requestAt).not.toBeNull();
  expect(probe.firstDeltaAt).not.toBeNull();
  const waitingSeconds = (probe.firstDeltaAt - probe.requestAt) / 1000;
  const requiredUpdates = Math.max(1, Math.floor(waitingSeconds));
  const progressTimes = probe.arrivals.filter((a: any) =>
    a.type === "progress" && a.event.id === "chat-answer-wait" &&
    a.elapsedMs <= waitingSeconds * 1000,
  ).map((a: any) => ({ atMs: a.elapsedMs, elapsedSeconds: a.event.elapsed_seconds }));
  const toolIntervals = probe.arrivals.filter((a: any) => a.type === "tool_start")
    .map((start: any) => {
      const end = probe.arrivals.find((a: any) => a.type === "tool_end" &&
        a.tool === start.tool && a.elapsedMs >= start.elapsedMs);
      return { tool: start.tool, startMs: start.elapsedMs,
        endMs: end?.elapsedMs ?? null, reportedToolMs: end?.event.ms ?? null };
    });
  const firstTool = toolIntervals[0];
  const lastToolEnd = toolIntervals.at(-1)?.endMs;
  const timing = {
    waitingSeconds, requiredUpdates, receivedUpdates: progressTimes.length,
    requestMs: 0, firstDeltaMs: waitingSeconds * 1000,
    beforeTools: { startMs: 0, endMs: firstTool?.startMs ?? null },
    toolIntervals,
    afterToolsBeforeAnswer: { startMs: lastToolEnd ?? null, endMs: waitingSeconds * 1000 },
    backendModelTimings: probe.events.find((e: any) => e.type === "done")?.phase_timings,
    progressTimes,
    note: "Times are browser arrivals relative to request dispatch. Tool start/end are protocol boundaries; delayed tool_end may overlap model generation. Backend phase durations do not provide absolute start times.",
  };
  console.log(JSON.stringify(timing));
  await info.attach("wait-phase-timing", { body: JSON.stringify(timing, null, 2), contentType: "application/json" });
  expect.soft(progressTimes.length, `request-to-first-delta wait=${waitingSeconds}s`).toBeGreaterThanOrEqual(requiredUpdates);
  expect(probe.samples.length).toBeGreaterThanOrEqual(1);
  expect(new Set(probe.samples.map((s: any) => s.id)).size).toBe(1);
  expect(Math.max(...probe.samples.map((s: any) => s.count))).toBe(1);
  expect.soft(new Set(probe.samples.map((s: any) => s.text)).size).toBeGreaterThanOrEqual(
    requiredUpdates,
  );
  expect(
    probe.events.some(
      (e: any) => e.type === "tool_start" && e.tool === "current_energy",
    ),
  ).toBe(true);
  expect(probe.events.some((e: any) => e.type === "done")).toBe(true);
  await page.locator(".agent-chat-process summary").last().click();
  await expect(page.locator(".agent-process-list").last()).toContainText(
    // 4a9f59e: native tool display name wins over legacy fallback label.
    process.env.CHAT_AGENT_LOOP === "1" ? "当前能源" : "查询当前能源",
  );
  console.log(
    JSON.stringify({
      waitingSeconds, requiredUpdates,
      waitUpdates: waits.length,
      uniqueNodes: new Set(probe.samples.map((s: any) => s.id)).size,
      maxRows: Math.max(...probe.samples.map((s: any) => s.count)),
      answer: await page.locator(".agent-answer-text").last().innerText(),
    }),
  );
  await info.attach("live-answer", {
    body: await page.screenshot({ path: info.outputPath("live-answer.png") }),
    contentType: "image/png",
  });
});
