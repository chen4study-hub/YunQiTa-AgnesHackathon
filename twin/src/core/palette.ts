export const clamp = (x: number) => Math.max(0, Math.min(1, x));
export function daylight(hour: number) {
  return clamp(Math.sin(((hour - 6) * Math.PI) / 12) * 1.3);
}
export function normalize(load: number, max: number) {
  return max > 0 ? clamp(load / max) : 0;
}
export function heatColor(t: number) {
  t = clamp(t);
  const a = t < 0.5 ? [47, 191, 143] : [242, 179, 61],
    b = t < 0.5 ? [242, 179, 61] : [255, 106, 61],
    f = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return (
    (Math.round(a[0] + (b[0] - a[0]) * f) << 16) |
    (Math.round(a[1] + (b[1] - a[1]) * f) << 8) |
    Math.round(a[2] + (b[2] - a[2]) * f)
  );
}
