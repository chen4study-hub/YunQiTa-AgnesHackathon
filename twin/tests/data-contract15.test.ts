import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ReplayFileAdapter,
  ApiAdapter,
  MockAdapter,
} from "../src/data/adapters";
import { createSource } from "../src/data/source";
import { validateReplay, validateAgentDetail } from "../src/data/validate";
import { DashboardStore } from "../src/state/store";
import { stubRaf } from "./raf-test-helper";
const file = (name: string) => readFileSync(`public/replay/${name}`);
const main = (sc = "normal") =>
  validateReplay(JSON.parse(file(`${sc}.json`).toString()));
const sha = (sc = "normal") =>
  createHash("sha256")
    .update(file(`${sc}.json`))
    .digest("hex");
beforeEach(stubRaf);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("all synchronized 1.5 mains and details pass schema, hash, identity and all 24 indexes", () => {
  for (const sc of ["normal", "peak", "abstain"]) {
    const data = main(sc),
      detail = validateAgentDetail(
        JSON.parse(file(`${sc}.agent-detail.json`).toString()),
        data,
        sha(sc),
      );
    expect(data.schema_version).toBe("1.5");
    expect(data.meta.agent_detail_file).toBe(`${sc}.agent-detail.json`);
    data.hours.forEach((h) =>
      expect(detail.hours[String(h.agent.detail_index)].t).toBe(h.t),
    );
  }
});
it("rejects wrong main hash, identity, timestamp/index, malformed and mismatched evidence", () => {
  const data = main(),
    raw = JSON.parse(file("normal.agent-detail.json").toString());
  for (const patch of [
    { main_sha256: "0".repeat(64) },
    { scenario: "peak" },
    { building_id: "wrong" },
    { schema_version: "1.4" },
  ])
    expect(() =>
      validateAgentDetail({ ...raw, ...patch }, data, sha()),
    ).toThrow();
  const changed = structuredClone(raw);
  changed.hours["14"].t = data.hours[13].t;
  expect(() => validateAgentDetail(changed, data, sha())).toThrow();
  const mainChanged = structuredClone(data);
  mainChanged.hours[14].agent.detail_index = 13;
  expect(() => validateAgentDetail(raw, mainChanged, sha())).toThrow();
});
it("main loads no companion; evidence request follows meta/detail_index and caches only validated results", async () => {
  const fetch = vi.fn(
    async (url: string) => new Response(file(url.split("/").pop()!)),
  );
  vi.stubGlobal("fetch", fetch);
  const source = new ReplayFileAdapter("/replay"),
    data = await source.loadScenario("normal");
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/replay/normal.json"]);
  const [a, b] = await Promise.all([
    source.loadAgentDetail(data, 14),
    source.loadAgentDetail(data, 15),
  ]);
  expect(a.t).toBe(data.hours[14].t);
  expect(b.t).toBe(data.hours[15].t);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([
    "/replay/normal.json",
    "/replay/normal.agent-detail.json",
  ]);
});
it("bad companion is refused, cache cleared and next user retry fetches again", async () => {
  let broken = true;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("agent-detail.json")) {
      const x = JSON.parse(file("normal.agent-detail.json").toString());
      if (broken) x.main_sha256 = "0".repeat(64);
      return new Response(JSON.stringify(x));
    }
    return new Response(file("normal.json"));
  });
  vi.stubGlobal("fetch", fetch);
  const source = new ReplayFileAdapter("/replay"),
    data = await source.loadScenario("normal");
  await expect(source.loadAgentDetail(data, 14)).rejects.toThrow("不匹配");
  broken = false;
  expect((await source.loadAgentDetail(data, 14)).t).toBe(data.hours[14].t);
  expect(fetch).toHaveBeenCalledTimes(3);
  data.meta.agent_detail_file = "../escape.json";
  await expect(source.loadAgentDetail(data, 14)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("API reserialization is checked against byte-exact synchronized main before loading detail", async () => {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        url === "/api/replay/normal"
          ? JSON.stringify(main())
          : file(url.split("/").pop()!),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const source = new ApiAdapter("/api", "/replay"),
    data = await source.loadScenario("normal");
  expect((await source.loadAgentDetail(data, 14)).t).toBe(data.hours[14].t);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([
    "/api/replay/normal",
    "/replay/normal.json",
    "/replay/normal.agent-detail.json",
  ]);
  data.hours[14].agent.explanation = "different";
  const other = new ApiAdapter("/api", "/replay");
  const second = await other.loadScenario("normal");
  second.hours[14].agent.explanation = "different";
  await expect(other.loadAgentDetail(second, 14)).rejects.toThrow("API");
});
it("file and API failures propagate, explicit mock is only an opt-in fixture", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  for (const query of ["", "?source=file", "?source=api"]) {
    const source = createSource(query);
    await expect(source.loadScenario("normal")).rejects.toThrow();
    await expect(source.listScenarios()).rejects.toThrow();
    await expect(source.loadModelCard()).rejects.toThrow();
  }
  expect(
    (await createSource("?source=mock").loadScenario("normal")).meta
      .model_version,
  ).toBe("mock-contract-1.2");
});
it("store ends loading on failure and retry preserves selection/time; stale failures do not erase new data", async () => {
  const source = new MockAdapter();
  source.loadScenario = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(main());
  const store = new DashboardStore(source, undefined, {
    query: "?at=2026-10-12T14:00",
  });
  await store.initialize();
  expect(store.getSnapshot()).toMatchObject({
    loadError: true,
    loading: false,
    data: null,
    hour: 14,
  });
  store.setHour(10);
  await store.retryLoad();
  expect(store.getSnapshot()).toMatchObject({
    loadError: false,
    loading: false,
    hour: 10,
  });
  store.dispose();
  let reject!: (error: Error) => void;
  source.loadScenario = vi
    .fn()
    .mockImplementationOnce(() => new Promise((_, fail) => (reject = fail)))
    .mockResolvedValue(main("peak"));
  const next = new DashboardStore(source, undefined, {
    query: "?at=2026-10-12T14:00",
  });
  const pending = next.loadScenario("normal");
  await next.loadScenario("peak");
  reject(new Error("late"));
  await pending;
  expect(next.getSnapshot()).toMatchObject({
    scenario: "peak",
    loadError: false,
    loading: false,
  });
  next.dispose();
});
it("missing model card reports load error and explicit retry recovers", async () => {
  const source = new MockAdapter();
  source.loadModelCard = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      model_version: "verified",
      target_coverage: 0.9,
      retained_coverage: null,
      cross_building_coverage: null,
      rejection_rate: null,
      retained_mae: null,
    });
  const store = new DashboardStore(source, undefined, {
    query: "?at=2026-10-12T14:00",
  });
  await store.initialize();
  expect(store.getSnapshot()).toMatchObject({
    loadError: true,
    loading: false,
    modelCard: null,
  });
  await store.retryLoad();
  expect(store.getSnapshot()).toMatchObject({
    loadError: false,
    loading: false,
  });
  store.dispose();
});
