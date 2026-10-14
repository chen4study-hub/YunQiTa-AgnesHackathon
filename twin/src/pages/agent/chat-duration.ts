import { formatPageNumber } from "../displayNumbers";

/** Presentation only: preserve timings; choose the unit before rounding. */
export function formatChatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 0.05) return "<0.1 ms";
  return ms < 1000
    ? `${formatPageNumber(ms, "decimal", false)} ms`
    : `${formatPageNumber(ms / 1000, "decimal", false)} s`;
}
