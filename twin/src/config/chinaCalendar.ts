import type { Scenario } from '../state/store';
import { localDateKey } from './localClock';

/** 国办发明电〔2025〕7号，2025-11-04；official mainland China schedule.
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 * Inclusive holiday ranges include the notified compensatory days off, not ordinary weekends.
 */
export const CHINA_HOLIDAYS_2026 = [
  { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
  { name: '春节', start: '2026-02-15', end: '2026-02-23' },
  { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
  { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
  { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
  { name: '国庆节', start: '2026-10-01', end: '2026-10-07' },
] as const;
export const CHINA_MAKEUP_WORKDAYS_2026: readonly string[] = [
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
];
export function chinaDay(value: Date | number) {
  const date = value instanceof Date ? value : new Date(value);
  const dateKey = localDateKey(date);
  const holiday = CHINA_HOLIDAYS_2026.find(h => dateKey >= h.start && dateKey <= h.end);
  const makeupWorkday = CHINA_MAKEUP_WORKDAYS_2026.includes(dateKey);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  return {
    dateKey,
    holidayName: holiday?.name ?? null,
    makeupWorkday,
    isWorkday: makeupWorkday || (!holiday && !weekend),
    /** Other years use weekend-only fallback; never claim unverified holiday coverage. */
    holidayTableCovered: date.getFullYear() === 2026,
  };
}
/** Hidden routing only. Workday exceptions override weekends; holiday/weekend overrides summer. */
export function scenarioForDate(value: Date | number): Scenario {
  if (!chinaDay(value).isWorkday) return 'abstain';
  const month = (value instanceof Date ? value : new Date(value)).getMonth() + 1;
  return month >= 6 && month <= 8 ? 'peak' : 'normal';
}
export function scenarioOverride(query: string): Scenario | null {
  const value = new URLSearchParams(query).get('scenario');
  return value === 'normal' || value === 'peak' || value === 'abstain' ? value : null;
}
