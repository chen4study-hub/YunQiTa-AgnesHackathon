import { createOpsLoader } from "./loader";
import { createOpsClock } from "./clock";
import { OPS_DAY_MS, type OpsCalendar, type OpsDay } from "./model";

/** Synchronous frame reader over asynchronous data. No requests per animation frame. */
export function createOpsTimeline(loader = createOpsLoader()) {
  let calendar: OpsCalendar | null = null;
  let calendarPending = false,
    calendarRetryAt = 0;
  const days = new Map<string, OpsDay>();
  const pending = new Set<string>(),
    retryAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  function getDay(at_ms: number): OpsDay | null {
    if (!Number.isFinite(at_ms)) return null;
    if (!calendar) {
      if (!calendarPending && performance.now() >= calendarRetryAt) {
        calendarPending = true;
        void loader
          .loadCalendar()
          .then((data) => {
            calendar = data;
            notify();
          })
          .catch(() => {
            calendarRetryAt = performance.now() + 30_000;
          })
          .finally(() => {
            calendarPending = false;
          });
      }
      return null;
    }
    const entry = calendar.days.find(
      (d) => at_ms >= d.day_start_ms && at_ms < d.day_start_ms + OPS_DAY_MS,
    );
    if (!entry) return null;
    const cached = days.get(entry.date);
    if (cached) return cached;
    if (
      !pending.has(entry.date) &&
      performance.now() >= (retryAt.get(entry.date) ?? 0)
    ) {
      pending.add(entry.date);
      void loader
        .loadDay(entry.date)
        .then((day) => {
          days.set(entry.date, day);
          if (days.size > 4) days.delete(days.keys().next().value!);
          retryAt.delete(entry.date);
          notify();
        })
        .catch(() => {
          retryAt.set(entry.date, performance.now() + 30_000);
        })
        .finally(() => pending.delete(entry.date));
    }
    return null;
  }
  return {
    getDay,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
// One cache and one calibrated clock shared by the app, not created in a render loop.
export const opsTimeline = createOpsTimeline();
export const opsClock = createOpsClock();
