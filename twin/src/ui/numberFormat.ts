/** Shared display formatter. Never round source measurements or contract payloads. */
const cache = new Map<string, Intl.NumberFormat>();
export function formatNumber(value: number, digits = 1, useGrouping = true): string {
  if (!Number.isFinite(value)) return '—';
  const precision = Math.max(0, Math.min(2, Math.trunc(digits)));
  const key = `${precision}|${useGrouping}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {minimumFractionDigits:precision,maximumFractionDigits:precision,useGrouping});
    cache.set(key, formatter);
  }
  const rounded = roundDisplay(value, precision);
  return formatter.format(Object.is(rounded,-0) ? 0 : rounded);
}
export function roundDisplay(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}
