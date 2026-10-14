import * as T from "three";
import type { TwinSceneOptions } from "./TwinScene";
type Attribute = { array: T.TypedArray; itemSize: number; normalized: boolean };
type Packed = {
  attributes: Record<string, Attribute>;
  index: Attribute | null;
  groups: { start: number; count: number; materialIndex?: number }[];
};
const FORMAT = 1;
const DATABASE = "yunqi-static-geometry";
function pack(g: T.BufferGeometry): Packed {
  const attributes: Record<string, Attribute> = {};
  for (const [name, a] of Object.entries(g.attributes)) {
    if (!(a instanceof T.BufferAttribute))
      throw new Error("Interleaved cache attribute");
    attributes[name] = {
      array: a.array.slice() as T.TypedArray,
      itemSize: a.itemSize,
      normalized: a.normalized,
    };
  }
  const a = g.index;
  return {
    attributes,
    index: a
      ? {
          array: a.array.slice() as T.TypedArray,
          itemSize: 1,
          normalized: false,
        }
      : null,
    groups: g.groups.map((v) => ({ ...v })),
  };
}
function unpack(p: Packed): T.BufferGeometry {
  const g = new T.BufferGeometry();
  try {
    if (!p.attributes.position) throw new Error("Missing positions");
    for (const [name, a] of Object.entries(p.attributes)) {
      if (
        !ArrayBuffer.isView(a.array) ||
        a.array instanceof DataView ||
        a.itemSize < 1 ||
        a.array.length % a.itemSize
      )
        throw new Error("Invalid geometry cache");
      g.setAttribute(
        name,
        new T.BufferAttribute(
          a.array.slice() as T.TypedArray,
          a.itemSize,
          a.normalized,
        ),
      );
    }
    if (p.index)
      g.setIndex(
        new T.BufferAttribute(p.index.array.slice() as T.TypedArray, 1),
      );
    p.groups.forEach((v) => g.addGroup(v.start, v.count, v.materialIndex));
    return g;
  } catch (error) {
    g.dispose();
    throw error;
  }
}
/** The key includes build provenance, format and every scene geometry parameter. */
async function cacheKey(options: TwinSceneOptions) {
  const parameters = JSON.stringify({
    building: options.building,
    campusCount: options.campusCount ?? 150,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parameters),
  );
  const hash = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  return `${FORMAT}:${__BUILD_REVISION__ ?? "archive"}:${__BUILD_TIME__ ?? "source"}:${hash}`;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Cache timeout"));
    }, 2000);
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DATABASE, FORMAT);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    r.onupgradeneeded = () => r.result.createObjectStore("geometry");
    r.onerror = () => {
      clearTimeout(timer);
      reject(r.error);
    };
    r.onblocked = () => {
      expired = true;
      clearTimeout(timer);
      reject(new Error("Cache blocked"));
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      if (expired) r.result.close();
      else resolve(r.result);
    };
  });
}
async function access(
  key: string,
  write?: Record<string, Packed>,
): Promise<Record<string, Packed> | undefined> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("geometry", write ? "readwrite" : "readonly");
      const r = write
        ? tx.objectStore("geometry").put(write, key)
        : tx.objectStore("geometry").get(key);
      tx.oncomplete = () => resolve(write ? undefined : r.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export class GeometryCache {
  private entries: Record<string, Packed> = {};
  private pending = new Map<string, T.BufferGeometry>();
  hits = 0;
  private constructor(private key: string | null) {}
  static async load(options: TwinSceneOptions) {
    let cache = new GeometryCache(null);
    try {
      cache = new GeometryCache(await cacheKey(options));
      // Blocked/privacy-mode storage must never hold up the scene.
      const entries = await Promise.race([
        access(cache.key!),
        new Promise<undefined>((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (entries && typeof entries === "object") cache.entries = entries;
    } catch {
      cache.entries = {};
    }
    return cache;
  }
  peek(key: string): T.BufferGeometry | undefined {
    const pending = this.pending.get(key);
    if (pending) {
      this.hits++;
      return pending.clone();
    }
    const p = this.entries[key];
    if (!p) return;
    try {
      const geometry = unpack(p);
      this.hits++;
      return geometry;
    } catch {
      delete this.entries[key];
    }
  }
  get(key: string, generate: () => T.BufferGeometry): T.BufferGeometry {
    const hit = this.peek(key);
    if (hit) return hit;
    const g = generate();
    this.pending.set(key, g);
    return g;
  }
  save() {
    if (!this.key || !this.pending.size) return;
    const pending = new Map(this.pending);
    this.pending.clear();
    const iterator = pending.entries();
    const persist = () => {
      const started = performance.now();
      try {
        let item = iterator.next();
        while (!item.done) {
          const [key, g] = item.value;
          this.entries[key] = pack(g);
          if (performance.now() - started > 8) {
            setTimeout(persist, 0);
            return;
          }
          item = iterator.next();
        }
        void access(this.key!, this.entries).catch(() => {
          /* Storage is optional. */
        });
      } catch {
        /* Never block rendering on serialization or quota errors. */
      }
    };
    if ("requestIdleCallback" in window)
      window.requestIdleCallback(persist, { timeout: 2000 });
    else setTimeout(persist, 0);
  }
}
