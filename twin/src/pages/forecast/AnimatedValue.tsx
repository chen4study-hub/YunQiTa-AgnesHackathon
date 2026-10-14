import { useEffect, useRef, useState } from "react";
import { formatPageNumber } from "../displayNumbers";

const numeric = /-?\d[\d,]*(?:\.\d+)?/g;
const tokens = (text: string) => [...text.matchAll(numeric)];
const skeleton = (text: string) => text.replace(numeric, "#");
/** Presentation-only tween. Flags/decisions and accessible values stay discrete. */
export function AnimatedValue({ text }: { text: string }) {
  const [display, setDisplay] = useState(text);
  const displayed = useRef(text);
  useEffect(() => {
    const previous = displayed.current;
    const from = tokens(previous).map((m) => Number(m[0].replaceAll(",", "")));
    const to = tokens(text);
    let frame = 0;
    const finish = () => {
      displayed.current = text;
      setDisplay(text);
    };
    if (
      skeleton(previous) !== skeleton(text) ||
      from.length !== to.length ||
      !to.length ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finish();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 280);
      const eased = 1 - (1 - progress) ** 3;
      let i = 0;
      const next = text.replace(numeric, (target) => {
        const end = Number(target.replaceAll(",", ""));
        const begin = from[i++];
        const value = begin + (end - begin) * eased;
        const digits = target.split(".")[1]?.length ?? 0;
        return formatPageNumber(
          value,
          digits ? "decimal" : "integer",
          target.includes(","),
        );
      });
      displayed.current = next;
      setDisplay(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return (
    <span className="smooth-value" aria-label={text}>
      <span aria-hidden="true">{display}</span>
    </span>
  );
}
