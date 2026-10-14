import { useEffect, useState, useSyncExternalStore } from "react";
import { useDashboard } from "../../state/context";
import {
  createOpsLoader,
  createOpsClock,
  evaluateOpsSnapshot,
  OPS_DAY_MS,
  type OpsDay,
  type OpsWindow,
} from "../../data/ops";

export type PageOpsLoader = ReturnType<typeof createOpsLoader>;
export type PageOpsClock = Pick<ReturnType<typeof createOpsClock>, "sync">;
export type PageOpsState = {
  day: OpsDay | null;
  loading: boolean;
  error: string | null;
};
const contains = (day: OpsDay, at: number) =>
  at >= day.day_start_ms && at < day.day_start_ms + OPS_DAY_MS;
/** Two-page cache. Clock calibration precedes loads; display time remains the store's.
 * Reads never substitute a scenario, prior day, source history or legacy replay. */
export function createPageOpsResource(
  loader: PageOpsLoader = createOpsLoader(),
  clock: PageOpsClock = createOpsClock(),
) {
  let state: PageOpsState = { day: null, loading: false, error: null };
  let synced: Promise<unknown> | undefined;
  let pending: Promise<void> | undefined;
  let requested = 0,
    failedAt: number | null = null,
    generation = 0;
  const listeners = new Set<() => void>();
  const update = (next: PageOpsState) => {
    state = next;
    listeners.forEach((fn) => fn());
  };
  const sync = () => (synced ??= clock.sync());
  function ensure(at: number, retry = false): Promise<void> {
    if (!Number.isFinite(at)) return Promise.resolve();
    if (state.day && contains(state.day, at) && !retry)
      return Promise.resolve();
    // Store displays can advance continuously. Coalesce requests within one day.
    const sameRequestDay =
      Math.abs(at - requested) < OPS_DAY_MS &&
      new Date(at).toDateString() === new Date(requested).toDateString();
    if (!retry && pending && sameRequestDay) return pending;
    if (
      !retry &&
      failedAt !== null &&
      new Date(at).toDateString() === new Date(failedAt).toDateString()
    )
      return Promise.resolve();
    requested = at;
    const token = ++generation;
    failedAt = null;
    update({ day: null, loading: true, error: null });
    pending = (async () => {
      try {
        await sync();
        const day = await loader.loadAt(at);
        if (!contains(day, at))
          throw new Error("Ops day does not cover display time");
        if (token === generation) update({ day, loading: false, error: null });
      } catch (error) {
        if (token === generation) {
          failedAt = at;
          update({
            day: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (token === generation) pending = undefined;
      }
    })();
    return pending;
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    ensure,
    retry(at: number) {
      synced = undefined;
      loader.clearCache();
      return ensure(at, true);
    },
    /** For genuinely cross-date charts/records: never concatenate modulo-hour templates. */
    async loadWindow(start: number, end: number) {
      await sync();
      return loader.loadWindow(start, end);
    },
  };
}
export const pageOps = createPageOpsResource();

/** Match BottomBar's displayed absolute time, including continuous playback.
 * rAF has no HTTP calls: evaluate the public pure snapshot on every frame. */
export function useOpsPage() {
  const { state, store } = useDashboard();
  const [windowState, setWindowState] = useState<{
    start: number | null;
    data: OpsWindow | null;
    error: string | null;
  }>({ start: null, data: null, error: null });
  const [windowRetry, setWindowRetry] = useState(0);
  const windowStart = state.playbackStartMs;
  useEffect(() => {
    let cancelled = false;
    if (windowStart === null) {
      setWindowState({ start: null, data: null, error: null });
      return;
    }
    setWindowState({ start: windowStart, data: null, error: null });
    void pageOps
      .loadWindow(windowStart, windowStart + OPS_DAY_MS)
      .then((data) => {
        if (!cancelled)
          setWindowState({ start: windowStart, data, error: null });
      })
      .catch((error) => {
        if (!cancelled)
          setWindowState({
            start: windowStart,
            data: null,
            error: String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [windowStart, windowRetry]);
  const displayedNow = () => {
    const state = store.getSnapshot();
    return state.followingCurrent && state.playbackStartMs === null
      ? store.getRealNowMs()
      : store.getPlaybackFrame().nowMs;
  };
  const [atMs, setAtMs] = useState(displayedNow);
  const loaded = useSyncExternalStore(
    pageOps.subscribe,
    pageOps.getSnapshot,
    pageOps.getSnapshot,
  );
  useEffect(() => {
    let request = 0;
    const frame = () => {
      setAtMs(displayedNow());
      request = requestAnimationFrame(frame);
    };
    const unsubscribe = store.subscribePlayback(() => setAtMs(displayedNow()));
    request = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(request);
      unsubscribe();
    };
  }, [store]);
  useEffect(() => {
    void pageOps.ensure(atMs);
  }, [atMs]);
  const windowError =
    windowState.start === windowStart ? windowState.error : null;
  const windowLoading =
    windowStart !== null &&
    (windowState.start !== windowStart || (!windowState.data && !windowError));
  // A loaded calendar window already owns the adjacent day's real readings.
  // Do not clear the page (and dispose its charts) while the single-day resource
  // catches up at midnight. Until a new window arrives, use only a day that
  // actually covers the display time, never yesterday's readings.
  const activeWindow =
    windowStart !== null && windowState.start === windowStart && !windowError
      ? windowState.data
      : null;
  const windowDay = activeWindow?.days.find(({ data }) =>
    contains(data, atMs),
  )?.data;
  const day = !windowError
    ? (windowDay ??
      (loaded.day && contains(loaded.day, atMs) ? loaded.day : null))
    : null;
  const snapshot = day ? evaluateOpsSnapshot(day, atMs) : null;
  return {
    day,
    snapshot,
    atMs,
    chartData: activeWindow ?? day,
    loading:
      loaded.loading ||
      windowLoading ||
      (!day && !loaded.error && !windowError),
    error: loaded.error ?? windowError,
    retry: () => {
      void pageOps.retry(displayedNow());
      setWindowRetry((n) => n + 1);
    },
  };
}
