import type { Scenario, Page } from "../state/store";
import { chinaDay } from './chinaCalendar';
import { resolveClock, localClockText } from './localClock';

/** Visible local calendar, independent of the hidden data route.
 * Pass state.nowMs (or Date). Legacy scenario arguments are ignored for a compiling migration;
 * they resolve browser now / hidden ?at, never a representative date.
 */
export function formatDisplayDate(value?: Date | number | Scenario): string {
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : resolveClock().read());
  const day = chinaDay(date);
  return `${day.dateKey} 周${'日一二三四五六'[date.getDay()]}${day.holidayName ? ` ${day.holidayName}` : ''}`;
}
export function formatDisplayTimestamp(value: Date | number): string {
  return `${formatDisplayDate(value)} ${localClockText(value)}`;
}
export const pages: { id: Page; label: string; english: string }[] = [
  { id: "overview", label: "总览", english: "OVERVIEW" },
  { id: "forecast", label: "预测与风险", english: "FORECAST & RISK" },
  { id: "agent", label: "Agent 决策", english: "AGENT DECISIONS" },
  { id: "floors", label: "楼层与电梯", english: "FLOORS & LIFTS" },
  { id: "energy", label: "能源与告警", english: "ENERGY & ALARMS" },
  { id: "about", label: "关于", english: "ABOUT" },
];
