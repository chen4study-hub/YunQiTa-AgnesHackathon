import { useSyncExternalStore } from "react";
import { opsTimeline } from "./runtime";
/** Async loads notify subscribers; no hourly prices copied into component constants. */
export function useOpsDay(at_ms: number) {
  return useSyncExternalStore(
    opsTimeline.subscribe,
    () => opsTimeline.getDay(at_ms),
    () => null,
  );
}
