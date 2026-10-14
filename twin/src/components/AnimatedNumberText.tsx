import { useEffect, useRef, useState } from "react";
import {formatNumber} from '../ui/numberFormat';

const pattern = /-?\d[\d,]*(?:\.\d+)?/g;
const skeleton = (text: string) => text.replace(pattern, "#");
/** Presentation only: do not tween timestamps, discrete counts or decisions. */
export function interpolateNumberText(
  from: string,
  to: string,
  progress: number,
) {
  const starts = [...from.matchAll(pattern)].map((match) =>
    Number(match[0].replaceAll(",", "")),
  );
  const ends = [...to.matchAll(pattern)];
  if (
    progress >= 1 ||
    skeleton(from) !== skeleton(to) ||
    starts.length !== ends.length
  )
    return to;
  const u = Math.max(0, Math.min(1, progress));
  const eased = 1 - (1 - u) ** 3;
  let index = 0;
  return to.replace(pattern, (target) => {
    const start = starts[index++],
      end = Number(target.replaceAll(",", ""));
    const digits = target.split(".")[1]?.length ?? 0;
    return formatNumber(start + (end - start) * eased,digits,target.includes(','));
  });
}
export function AnimatedNumberText({
  text,
  immediate = false,
}: {
  text: string;
  immediate?: boolean;
}) {
  const [display, setDisplay] = useState(text);
  const shown = useRef(text);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const from = shown.current;
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      shown.current = text;
      if(!immediate)setDisplay(text);
    };
    if (
      immediate ||
      media.matches ||
      from === text ||
      skeleton(from) !== skeleton(text)
    ) {
      finish();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 280);
      shown.current = interpolateNumberText(from, text, progress);
      setDisplay(shown.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const reduce = () => {
      if (media.matches) finish();
    };
    media.addEventListener("change", reduce);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", reduce);
    };
  }, [text, immediate]);
  return (
    <span className="animated-number-text" aria-label={text} data-target={text}>
      <span aria-hidden="true">{immediate?text:display}</span>
    </span>
  );
}
