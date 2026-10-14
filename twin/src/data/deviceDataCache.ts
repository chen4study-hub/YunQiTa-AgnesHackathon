export interface DataManifest {
  schemaVersion: 1;
  files: Record<string, { sha256: string; bytes: number }>;
}
export interface CachedData {
  sha256: string;
  bytes: ArrayBuffer;
  parsed: unknown;
  contentType: string;
}
export interface DataStorage {
  get(key: string): Promise<CachedData | undefined>;
  put(key: string, value: CachedData): Promise<void>;
}

export function indexedDataStorage(): DataStorage {
  async function open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("yunqi-data-cache", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files");
      let settled = false;
      const fail = (error: unknown) => {
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("Data storage timed out")),
        1500,
      );
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error("Data storage blocked"));
    });
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("files", mode);
        let settled = false;
        let request: IDBRequest<T> | undefined;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined) reject(error);
          else resolve(request!.result);
        };
        const abortIfPending = () => {
          // A native transaction may have finished before its queued event arrives.
          // InvalidStateError must never escape a timer or mask the original failure.
          try {
            tx.abort();
          } catch {
            /* Already ended. */
          }
        };
        const timer = setTimeout(() => {
          if (settled) return;
          finish(new Error("Data storage timed out"));
          abortIfPending();
        }, 1500);
        tx.oncomplete = () => finish();
        tx.onerror = tx.onabort = () =>
          finish(
            tx.error ??
              request?.error ??
              new Error("Data storage transaction failed"),
          );
        try {
          request = action(tx.objectStore("files"));
        } catch (error) {
          finish(error);
          abortIfPending();
        }
      });
    } finally {
      db.close();
    }
  }
  return {
    get: (key) => transaction("readonly", (store) => store.get(key)),
    async put(key, value) {
      // One record per URL: replacing it atomically removes the previous version.
      await transaction("readwrite", (store) => store.put(value, key));
    },
  };
}

class ParsedResponse extends Response {
  constructor(private readonly entry: CachedData) {
    super(entry.bytes.slice(0), {
      status: 200,
      headers: { "Content-Type": entry.contentType },
    });
  }
  override async json() {
    // Preserve native Response body consumption, but do not parse JSON again.
    await super.arrayBuffer();
    return structuredClone(this.entry.parsed);
  }
  override clone(): Response {
    if (this.bodyUsed) throw new TypeError("Body already consumed");
    return new ParsedResponse(this.entry);
  }
}
function manifest(input: unknown): DataManifest {
  const value = input as DataManifest;
  if (
    value?.schemaVersion !== 1 ||
    !value.files ||
    typeof value.files !== "object"
  )
    throw new Error("Invalid data manifest");
  for (const [name, entry] of Object.entries(value.files)) {
    if (
      name.includes("..") ||
      name.startsWith("/") ||
      !name.endsWith(".json") ||
      !/^[a-f0-9]{64}$/.test(entry?.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    )
      throw new Error("Invalid data manifest entry");
  }
  return value;
}

export function createDeviceDataFetch(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  storage?: DataStorage;
}) {
  const network = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = new URL(options.baseUrl);
  const storage = options.storage ?? indexedDataStorage();
  const pending = new Map<string, Promise<CachedData>>();
  let checking: Promise<DataManifest> | undefined;
  async function checkManifest() {
    // One version snapshot per page/reader, including sequential main/sidecar
    // reads. Never persist it: each reload/new tab revalidates via HTTP.
    if (!checking) {
      checking = (async () => {
        const result = await network(new URL("data-manifest.json", base), {
          cache: "no-cache",
        });
        if (!result.ok) throw new Error(`Data manifest HTTP ${result.status}`);
        return manifest(await result.json());
      })().catch((error) => {
        // A transient failure must not pin this reader to the fallback forever.
        checking = undefined;
        throw error;
      });
    }
    return checking;
  }
  async function read(
    url: URL,
    sha256: string,
    init?: RequestInit,
  ): Promise<CachedData> {
    const key = url.origin + url.pathname;
    let cached: CachedData | undefined;
    try {
      cached = await storage.get(key);
    } catch {
      /* Disabled/private/quota storage must not prevent networking. */
    }
    if (cached?.sha256 === sha256 && cached.bytes instanceof ArrayBuffer)
      return cached;
    url.searchParams.set("v", sha256.slice(0, 12));
    const result = await network(url, { ...init, cache: "no-cache" });
    if (!result.ok) throw new Error(`Data HTTP ${result.status}`);
    const bytes = await result.arrayBuffer();
    const actual = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== sha256)
      throw new Error(
        "Data version does not match manifest; retry after update completes",
      );
    const entry: CachedData = {
      sha256,
      bytes,
      parsed: JSON.parse(new TextDecoder().decode(bytes)),
      contentType: result.headers.get("Content-Type") ?? "application/json",
    };
    try {
      await storage.put(key, entry);
    } catch {
      /* Network data remains usable when persistence fails. */
    }
    return entry;
  }
  return async function deviceFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, base);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      method !== "GET" ||
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname + "replay/") ||
      !url.pathname.endsWith(".json") ||
      input instanceof Request
    )
      return network(input, init);
    const name = decodeURIComponent(
      url.pathname.slice((base.pathname + "replay/").length),
    );
    let versions: DataManifest;
    try {
      versions = await checkManifest();
    } catch {
      return network(input, init);
    } // Older deployments without a manifest remain usable.
    const version = versions.files[name]?.sha256;
    if (!version) return network(input, init);
    const key = url.origin + url.pathname + "|" + version;
    if (!pending.has(key)) {
      const load = async () => read(url, version, init);
      const locks = globalThis.navigator?.locks;
      let started = false;
      pending.set(
        key,
        locks
          ? locks
              .request(`yunqi-data:${url.pathname}`, async () => {
                started = true;
                return load();
              })
              .catch((error) => {
                if (started) throw error;
                return load();
              })
          : load(),
      );
    }
    const active = pending.get(key)!;
    try {
      return new ParsedResponse(await active);
    } finally {
      if (pending.get(key) === active) pending.delete(key);
    }
  };
}

/** Narrow transport hook: existing A-owned adapters remain untouched. */
export function installDeviceDataCache() {
  globalThis.fetch = createDeviceDataFetch({
    baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href,
  });
}
