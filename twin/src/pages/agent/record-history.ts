import { validateOps, validateOpsCalendar } from "../../data/validators";
import type { ReplayData, TwinDataSource } from "../../data/types";
import { localDateKey } from "../../config/localClock";
export interface PreviousDay {
  date: string;
  data: ReplayData;
}
/** Calendar is the authority; never infer yesterday's route from today's scenario. */
export async function loadPreviousDay(
  source: TwinDataSource,
  nowMs: number,
  base = `${import.meta.env.BASE_URL}replay`,
): Promise<PreviousDay | null> {
  try {
    const yesterday = new Date(nowMs);
    yesterday.setDate(yesterday.getDate() - 1);
    const date = localDateKey(yesterday);
    const response = await fetch(`${base}/ops-calendar.json`);
    if (!response.ok) return null;
    const calendar = await response.json();
    if (!validateOps(calendar) || !validateOpsCalendar(calendar)) return null;
    const typed = calendar as unknown as {
      days: { date: string; scenario: string; source_date: string }[];
    };
    const entries = typed.days.filter((d) => d.date === date);
    if (entries.length !== 1) return null;
    const entry = entries[0];
    const data = await source.loadScenario(entry.scenario);
    if (
      data.meta.scenario !== entry.scenario ||
      data.meta.date !== entry.source_date
    )
      return null;
    return { date, data };
  } catch {
    return null;
  }
}
