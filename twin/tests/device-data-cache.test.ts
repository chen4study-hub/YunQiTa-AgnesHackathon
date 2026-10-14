import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createDeviceDataFetch,
  type CachedData,
  type DataStorage,
} from "../src/data/deviceDataCache";

function fixture(storage?: DataStorage) {
  let body = '{"value":1}';
  const records = new Map<string, CachedData>();
  const network = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("data-manifest.json"))
      return Response.json({
        schemaVersion: 1,
        files: {
          "test.json": {
            sha256: createHash("sha256").update(body).digest("hex"),
            bytes: Buffer.byteLength(body),
          },
        },
      });
    return new Response(body, {
      headers: { "Content-Type": "application/json" },
    });
  });
  const local = storage ?? {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: CachedData) => {
      records.set(key, value);
    },
  };
  const reader = () =>
    createDeviceDataFetch({
      baseUrl: "https://example.test/",
      fetch: network as typeof fetch,
      storage: local,
    });
  return {
    reader,
    network,
    records,
    update: () => {
      body = '{"value":2}';
    },
  };
}
it("revalidates manifest but reads parsed local data after recreation; replaces old versions", async () => {
  const f = fixture();
  expect(
    await (await f.reader()("https://example.test/replay/test.json")).json(),
  ).toEqual({ value: 1 });
  const downloaded = f.network.mock.calls.filter(([url]) =>
    String(url).includes("test.json"),
  );
  expect(downloaded).toHaveLength(1);
  expect(String(downloaded[0][0])).toMatch(/\?v=[a-f0-9]{12}$/);
  const response = await f.reader()("https://example.test/replay/test.json");
  const clone = response.clone();
  expect(await response.json()).toEqual({ value: 1 });
  expect(await clone.json()).toEqual({ value: 1 });
  await expect(response.json()).rejects.toThrow();
  expect(
    f.network.mock.calls.filter(([url]) => String(url).includes("test.json")),
  ).toHaveLength(1);
  expect(
    f.network.mock.calls.filter(([url]) => String(url).includes("manifest")),
  ).toHaveLength(2);
  f.update();
  expect(
    await (await f.reader()("https://example.test/replay/test.json")).json(),
  ).toEqual({ value: 2 });
  expect(f.records.size).toBe(1);
  expect(
    f.network.mock.calls.filter(([url]) => String(url).includes("test.json")),
  ).toHaveLength(2);
});
it("one page snapshot serves sequential main and sidecar reads; a new reader revalidates", async () => {
  const body = '{"value":1}',
    sha256 = createHash("sha256").update(body).digest("hex");
  const network = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("manifest")
      ? Response.json({
          schemaVersion: 1,
          files: Object.fromEntries(
            ["main.json", "floors.json", "detail.json"].map((name) => [
              name,
              { sha256, bytes: body.length },
            ]),
          ),
        })
      : new Response(body),
  );
  const storage: DataStorage = {
    get: async () => undefined,
    put: async () => {},
  };
  const create = () =>
    createDeviceDataFetch({
      baseUrl: "https://example.test/",
      fetch: network as typeof fetch,
      storage,
    });
  const reader = create();
  for (const name of ["main", "floors", "detail"])
    expect(
      await (await reader(`https://example.test/replay/${name}.json`)).json(),
    ).toEqual({ value: 1 });
  expect(
    network.mock.calls.filter(([url]) => String(url).includes("manifest")),
  ).toHaveLength(1);
  await create()("https://example.test/replay/main.json");
  expect(
    network.mock.calls.filter(([url]) => String(url).includes("manifest")),
  ).toHaveLength(2);
});
it("a failed manifest check can recover on the next data read", async () => {
  const f = fixture(),
    reader = f.reader();
  f.network.mockRejectedValueOnce(new Error("offline"));
  expect(
    await (await reader("https://example.test/replay/test.json")).json(),
  ).toEqual({ value: 1 });
  expect(
    await (await reader("https://example.test/replay/test.json")).json(),
  ).toEqual({ value: 1 });
  expect(
    f.network.mock.calls.filter(([url]) => String(url).includes("manifest")),
  ).toHaveLength(2);
});
it("storage read/write failure does not prevent versioned networking", async () => {
  const f = fixture({
    get: async () => {
      throw new Error("disabled");
    },
    put: async () => {
      throw new Error("quota");
    },
  });
  expect(
    await (await f.reader()("https://example.test/replay/test.json")).json(),
  ).toEqual({ value: 1 });
});
it("concurrent same-version reads download once and returned JSON is isolated", async () => {
  const f = fixture(),
    reader = f.reader();
  const [a, b] = await Promise.all([
    reader("https://example.test/replay/test.json"),
    reader("https://example.test/replay/test.json"),
  ]);
  const data = await a.json();
  data.value = 9;
  expect(await b.json()).toEqual({ value: 1 });
  expect(
    f.network.mock.calls.filter(([url]) => String(url).includes("test.json")),
  ).toHaveLength(1);
});
it("passes non-data and non-GET requests straight through", async () => {
  const f = fixture(),
    reader = f.reader();
  await reader("https://example.test/api/test");
  await reader("https://example.test/replay/test.json", { method: "POST" });
  expect(f.network).toHaveBeenCalledTimes(2);
  expect(
    f.network.mock.calls.some(([url]) => String(url).includes("manifest")),
  ).toBe(false);
});
it("missing manifest falls back to network without trusting a stale local version", async () => {
  const network = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes("manifest")
      ? new Response("missing", { status: 404 })
      : Response.json({ network: true }),
  );
  const reader = createDeviceDataFetch({
    baseUrl: "https://example.test/",
    fetch: network as typeof fetch,
  });
  expect(
    await (await reader("https://example.test/replay/test.json")).json(),
  ).toEqual({ network: true });
});
it("refuses mismatched bytes and does not poison persistent storage", async () => {
  const put = vi.fn();
  const network = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes("manifest")
      ? Response.json({
          schemaVersion: 1,
          files: { "test.json": { sha256: "a".repeat(64), bytes: 1 } },
        })
      : Response.json({ mismatch: true }),
  );
  const reader = createDeviceDataFetch({
    baseUrl: "https://example.test/",
    fetch: network as typeof fetch,
    storage: { get: async () => undefined, put },
  });
  await expect(reader("https://example.test/replay/test.json")).rejects.toThrow(
    "version",
  );
  expect(put).not.toHaveBeenCalled();
});
