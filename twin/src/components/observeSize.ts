export interface ElementSize { width: number; height: number; }
/** Coalesce RO bursts into one frame, skip unchanged sizes, and report zero once. */
export function observeSize(element: HTMLElement, changed: (size: ElementSize) => void) {
  let frame = 0;
  let previous: ElementSize | null = null;
  const measure = () => {
    frame = 0;
    const width = element.clientWidth, height = element.clientHeight;
    if (previous?.width === width && previous.height === height) return;
    previous = { width, height };
    changed(previous);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const observer = new ResizeObserver(schedule);
  observer.observe(element);
  schedule();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}
