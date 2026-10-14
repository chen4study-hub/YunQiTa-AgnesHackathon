import { useLayoutEffect, useRef, type PropsWithChildren } from "react";

/** Ignore subpixel/collapsed-border rounding, not meaningful content overflow. */
export const needsTableScroll = (excess: number) => excess > 3;
export function AlertTableViewport({ children }: PropsWithChildren) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      // Measure without existing scrollbar deductions first; no intermediate paint.
      element.style.overflowX = "hidden";
      element.style.overflowY = "hidden";
      const x = needsTableScroll(element.scrollWidth - element.clientWidth);
      element.style.overflowX = x ? "auto" : "hidden";
      const y = needsTableScroll(element.scrollHeight - element.clientHeight);
      element.style.overflowY = y ? "auto" : "hidden";
      if (y && needsTableScroll(element.scrollWidth - element.clientWidth))
        element.style.overflowX = "auto";
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={host}
      className="energy-table-scroll"
      role="region"
      aria-label="告警表，可横向滚动"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
