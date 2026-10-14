import {
  readTakeover,
  takeoverCovers,
  takeoverRequest,
  type Takeover,
} from "../pages/agent/takeover-api";

/** Read-only overview feed. Unavailable or malformed services never surface an error. */
export async function loadActiveTakeover(
  date: string,
  hour: number,
  signal: AbortSignal,
): Promise<Takeover | null> {
  try {
    const result = await takeoverRequest(
      `/takeover/active?date=${encodeURIComponent(date)}&hour=${hour}`,
      undefined,
      signal,
    );
    const record = readTakeover(result.takeover);
    if (!record) return null;
    if (record.record_status === "active")
      return takeoverCovers(record, date, hour) ? record : null;
    // A's coverage predicate now excludes cancelled records. Keep the endpoint's
    // hour-scoped cancellation notice separately; it must never replace a decision.
    const at = Date.parse(
      `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`,
    );
    return record.record_status === "cancelled" &&
      record.start_ms <= at &&
      record.end_ms > at
      ? record
      : null;
  } catch {
    return null;
  }
}
export interface TakeoverPollEnvironment {
  document: EventTarget & { visibilityState: string };
  window: EventTarget;
}
/** One in-flight GET; hide/focus invalidates old responses, and teardown aborts all work. */
export function pollActiveTakeover(
  date: string,
  hour: number,
  publish: (record: Takeover | null) => void,
  env: TakeoverPollEnvironment = { document, window },
  load = loadActiveTakeover,
): () => void {
  let disposed = false;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    request?.abort();
    request = null;
  };
  const refresh = async () => {
    if (disposed || env.document.visibilityState === "hidden" || request)
      return;
    const controller = new AbortController();
    request = controller;
    try {
      const record = await load(date, hour, controller.signal);
      if (!disposed && !controller.signal.aborted && request === controller)
        publish(record);
    } catch {
      if (!disposed && !controller.signal.aborted && request === controller)
        publish(null);
    } finally {
      if (request === controller) request = null;
    }
  };
  const resume = () => {
    stop();
    if (disposed || env.document.visibilityState === "hidden") return;
    void refresh();
    timer = setInterval(() => void refresh(), 3000);
  };
  env.window.addEventListener("focus", resume);
  env.document.addEventListener("visibilitychange", resume);
  resume();
  return () => {
    disposed = true;
    stop();
    env.window.removeEventListener("focus", resume);
    env.document.removeEventListener("visibilitychange", resume);
  };
}
