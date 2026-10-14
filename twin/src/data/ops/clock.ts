import type { OpsFetch } from "./model";
export interface OpsClockOptions {
  fetch?: OpsFetch;
  timeUrl?: string;
  timeoutMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
}
export interface OpsClockSync {
  source: "backend" | "local";
  offset_ms: number;
  timezone: string | null;
  error?: string;
}
/** Explicit sync; no background timers or leaked requests. Re-sync after reconnect. */
export function createOpsClock(options: OpsClockOptions = {}) {
  const request: OpsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const wall = options.wallNow ?? (() => Date.now());
  const mono = options.monotonicNow ?? (() => performance.now());
  let anchor: number | undefined,
    anchorMono = 0;
  let state: OpsClockSync = { source: "local", offset_ms: 0, timezone: null };
  let pending: Promise<OpsClockSync> | undefined;
  function now() {
    return anchor === undefined ? wall() : anchor + (mono() - anchorMono);
  }
  function sync(): Promise<OpsClockSync> {
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const start = mono();
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Ops time timeout"));
          }, options.timeoutMs ?? 2500);
        });
        const backend = (async () => {
          const res = await request(options.timeUrl ?? "/api/ops/time", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`Ops time HTTP ${res.status}`);
          const data: unknown = await res.json();
          const d = data as {
            schema_version?: string;
            epoch_ms?: number;
            timezone?: string;
          };
          if (
            !d ||
            d.schema_version !== "1.0" ||
            !Number.isSafeInteger(d.epoch_ms) ||
            typeof d.timezone !== "string"
          )
            throw new Error("Ops time contract invalid");
          return { epoch_ms: d.epoch_ms!, timezone: d.timezone };
        })();
        const data = await Promise.race([backend, timeout]);
        const end = mono();
        // Server timestamp is anchored at the round-trip midpoint, then advances monotonically.
        anchor = data.epoch_ms + (end - start) / 2;
        anchorMono = end;
        state = {
          source: "backend",
          offset_ms: anchor - wall(),
          timezone: data.timezone,
        };
      } catch (error) {
        anchor = undefined;
        state = {
          source: "local",
          offset_ms: 0,
          timezone: null,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      return { ...state };
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  return { now, sync, getStatus: () => ({ ...state }) };
}
