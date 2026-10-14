import { afterEach, expect, it, vi } from "vitest";
import {
  indexedDataStorage,
  type CachedData,
} from "../src/data/deviceDataCache";
const value: CachedData = {
  sha256: "a".repeat(64),
  bytes: new ArrayBuffer(1),
  parsed: {},
  contentType: "application/json",
};
function idbFixture() {
  const callbacks: (() => void)[] = [];
  const nativeTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    if (delay === 1500) callbacks.push(callback);
    return nativeTimeout(callback, delay);
  }) as typeof setTimeout);
  let ended = false;
  const request = { result: undefined, error: null };
  const put = vi.fn(() => request);
  const tx = {
    error: null as Error | null,
    objectStore: () => ({ put, get: () => request }),
    oncomplete: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    abort: vi.fn(() => {
      if (ended)
        throw new DOMException(
          "The transaction has finished",
          "InvalidStateError",
        );
      ended = true;
      tx.onabort?.();
    }),
  };
  const db = { transaction: () => tx, close: vi.fn(), onversionchange: null };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const open = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => open.onsuccess?.());
      return open;
    },
  });
  return {
    callbacks,
    tx,
    db,
    put,
    endNative: () => {
      ended = true;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("successful IDB writes clear their timeout and a queued late callback never aborts the completed transaction", async () => {
  vi.useFakeTimers();
  const f = idbFixture();
  const result = indexedDataStorage().put("url", value);
  await vi.advanceTimersByTimeAsync(0);
  const timeout = f.callbacks.at(-1)!;
  f.endNative();
  f.tx.oncomplete!();
  await result;
  expect(() => timeout()).not.toThrow();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.tx.abort).not.toHaveBeenCalled();
  expect(f.db.close).toHaveBeenCalledOnce();
});
it.each(["onerror", "onabort"] as const)(
  "settles %s once and ignores the stale timeout callback",
  async (event) => {
    vi.useFakeTimers();
    const f = idbFixture();
    const result = indexedDataStorage().put("url", value);
    const rejected = expect(result).rejects.toThrow("quota");
    await vi.advanceTimersByTimeAsync(0);
    const timeout = f.callbacks.at(-1)!;
    f.tx.error = new Error("quota");
    f.endNative();
    f.tx[event]!();
    await rejected;
    expect(() => timeout()).not.toThrow();
    expect(f.tx.abort).not.toHaveBeenCalled();
    expect(f.db.close).toHaveBeenCalledOnce();
  },
);
it("a timeout aborts a pending write at most once, rejecting silently to the cache fallback", async () => {
  vi.useFakeTimers();
  const f = idbFixture();
  const result = indexedDataStorage().put("url", value),
    rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  expect(f.tx.abort).toHaveBeenCalledOnce();
  f.callbacks.at(-1)!();
  expect(f.tx.abort).toHaveBeenCalledOnce();
  expect(f.db.close).toHaveBeenCalledOnce();
});
it("native completion before delivery of oncomplete cannot cause an uncaught abort error", async () => {
  vi.useFakeTimers();
  const f = idbFixture();
  const result = indexedDataStorage().put("url", value),
    rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(0);
  f.endNative();
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  expect(f.tx.abort).toHaveBeenCalledOnce();
  expect(() => f.tx.oncomplete!()).not.toThrow();
  expect(f.db.close).toHaveBeenCalledOnce();
});
it("synchronous write errors clear the timer before closing the database", async () => {
  vi.useFakeTimers();
  const f = idbFixture();
  f.put.mockImplementation(() => {
    throw new Error("clone failed");
  });
  const result = indexedDataStorage().put("url", value),
    rejected = expect(result).rejects.toThrow("clone failed");
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
  expect(f.tx.abort).toHaveBeenCalledOnce();
  f.callbacks.at(-1)!();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.tx.abort).toHaveBeenCalledOnce();
  expect(f.db.close).toHaveBeenCalledOnce();
});
