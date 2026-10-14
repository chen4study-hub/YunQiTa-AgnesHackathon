/** Browser-local wall clock. Meter timestamps and API origins are never changed. */
export interface ClockOptions {
  query?: string;
  now?: () => number;
}
export function browserQuery(): string {
  return typeof location === 'undefined' ? '' : location.search;
}
/** Hidden deterministic local-date override; reject invalid/normalised dates and zones. */
export function parseLocalAt(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second = '00'] = match;
  const date = new Date(+y, +m - 1, +d, +h, +minute, +second);
  if (date.getFullYear() !== +y || date.getMonth() !== +m - 1 || date.getDate() !== +d || date.getHours() !== +h || date.getMinutes() !== +minute || date.getSeconds() !== +second) return null;
  return date.getTime();
}
export function resolveClock(options: ClockOptions = {}) {
  const query = options.query ?? browserQuery();
  const fixedAt = parseLocalAt(new URLSearchParams(query).get('at'));
  const now = options.now ?? Date.now;
  return { query, fixedAt, now, read: () => fixedAt ?? now() };
}
export function localDateKey(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function localClockText(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
