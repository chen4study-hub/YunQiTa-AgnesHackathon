import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../../data/types";
import {
  apiBase,
  chat,
  CHAT_TIMEOUT_MS,
  health,
  loadSchedule,
  request,
} from "./api";
const data = () =>
  JSON.parse(readFileSync("public/replay/normal.json", "utf8")) as ReplayData;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Agent API deadlines and backend authority", () => {
  it("uses configurable API base and derives LLM label from health only", async () => {
    expect(apiBase("?api=/api/")).toBe("/api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ llm: { mode: "real" } }),
      })),
    );
    expect(await health()).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await health()).toBe(false);
  });
  it("aborts within the configured short deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("timeout")),
            );
          }),
      ),
    );
    const promise = request("/health", undefined, 1000);
    const check = expect(promise).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });
  it("waits for a 15-second real LLM response, but falls back at the chat deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    grounded: true,
                    answer: "真实工具回答",
                    llm_mode: "real",
                  }),
                }),
              15_000,
            ),
          ),
      ),
    );
    const answer = chat("问题", "normal", data().hours[14].t);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await answer).toMatchObject({
      text: "真实工具回答",
      source: "backend",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("timeout")),
            );
          }),
      ),
    );
    let settled = false;
    const timed = chat("问题", "normal", data().hours[14].t).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await timed).toMatchObject({ text: "", requestError: true });
  });
  it("never repeats a confirmed/timed-out schedule for the same origin and sends whole-hour range", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetcher);
    const d = data();
    await Promise.all([
      loadSchedule(d, 13, "normal"),
      loadSchedule(d, 13, "normal"),
    ]);
    await loadSchedule(d, 13, "normal");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(requestBody.start).toBe(d.hours[13].t);
    expect(Date.parse(requestBody.end) - Date.parse(requestBody.start)).toBe(
      3_600_000,
    );
  });
  it("preserves backend answers regardless of grounding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          answer: "工具计算结果",
          llm_mode: "real",
          grounded: true,
          tool_trace: [{ tool: "get_forecast" }],
          origin: data().hours[14].t,
        }),
      })),
    );
    expect(await chat("预测", "normal", data().hours[14].t)).toMatchObject({
      source: "backend",
      llmMode: "real",
      tools: ["get_forecast"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ answer: "未验证", grounded: false }),
      })),
    );
    expect(await chat("预测", "normal", data().hours[14].t)).toMatchObject({
      text: "未验证",
    });
  });
});
