import { formatDisplayDate } from "../config/presentation";

/** Presentation only: original timestamps, request bodies and identifiers stay untouched. */
export function replayCalendar(_scenario: string, origin: string, displayAt?: Date | number) {
  // Third argument lets pages use the same store clock, including frozen ?at and midnight.
  // Legacy two-argument callers still compile and resolve the browser's current local date.
  const display = formatDisplayDate(displayAt).slice(0, 10);
  const source = origin.slice(0, 10);
  const sourceDay = Date.parse(`${source}T00:00:00Z`);
  const displayDay = Date.parse(`${display}T00:00:00Z`);
  const date = (year: string, month: string, day: string) => {
    const original = Date.parse(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00Z`,
    );
    if (!Number.isFinite(original) || !Number.isFinite(sourceDay))
      return display;
    return new Date(displayDay + original - sourceDay)
      .toISOString()
      .slice(0, 10);
  };
  const text = (value: string) =>
    value
      .replace(
        /(?<!\d)201([67])[-/年](\d{1,2})[-/月](\d{1,2})(?!\d)(?:日)?(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
        (_all, y, m, d, clock) =>
          `${date(`201${y}`, m, d)}${clock ? ` ${clock}` : ""}`,
      )
      .replace(/(?<!\d)201([67])(\d{2})(\d{2})(?!\d)/g, (_all, y, m, d) =>
        date(`201${y}`, m, d).replaceAll("-", ""),
      )
      // Historical model evaluation is not re-labelled as a current-year evaluation.
      // Latin units need an explicit ASCII token end; Chinese/% units cannot use \b.
      // Leave malformed date-like tokens intact rather than rewriting their year alone.
      .replace(
        /(?<!\d)201[67](?![\d.,]|[-/年]\d|\s*(?:kWh?(?![A-Za-z0-9_])|%|元|条|小时))/g,
        "历史年度",
      );
  return { text };
}
