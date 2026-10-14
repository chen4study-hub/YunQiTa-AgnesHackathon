import { useEffect, useRef, useState } from "react";

/** Keep target text/metadata, interpolate only finite numeric leaves. */
export function interpolateNumbers<T>(from: T, to: T, progress: number): T {
  if (typeof to === "number" && typeof from === "number")
    return (from + (to - from) * Math.max(0, Math.min(1, progress))) as T;
  if (Array.isArray(to))
    return to.map((value, index) =>
      interpolateNumbers(
        Array.isArray(from) ? from[index] : value,
        value,
        progress,
      ),
    ) as T;
  if (to && typeof to === "object") {
    const source =
      from && typeof from === "object" ? (from as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(to).map(([key, value]) => [
        key,
        interpolateNumbers(source[key] ?? value, value, progress),
      ]),
    ) as T;
  }
  return to;
}
export function useNumericTransition<T>(target: T, duration = 360): T {
  const [display, setDisplay] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (target == null || current.current == null) {
      current.current = target;
      setDisplay(target);
      return;
    }
    const from = current.current;
    let request = 0;
    let start: number | null = null;
    const tick = (timestamp: number) => {
      start ??= timestamp;
      const u = Math.min(1, (timestamp - start) / duration);
      current.current = interpolateNumbers(from, target, u * u * (3 - 2 * u));
      setDisplay(current.current);
      if (u < 1) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [target, duration]);
  return display ?? target;
}
