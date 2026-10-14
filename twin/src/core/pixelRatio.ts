export function qualityPixelRatio(dpr: number, quality: 'high' | 'low') {
  return Math.min(dpr, quality === 'high' ? 2 : 1);
}
/** A resolution query must be replaced after each change to catch subsequent zoom/monitor moves. */
export function watchDevicePixelRatio(
  onChange: () => void,
  media: (query: string) => MediaQueryList = window.matchMedia.bind(window),
  read: () => number = () => window.devicePixelRatio,
): () => void {
  let query: MediaQueryList;
  let stopped = false;
  const arm = () => {
    query = media(`(resolution: ${read()}dppx)`);
    query.addEventListener('change', changed);
  };
  const changed = () => {
    if (stopped) return;
    query.removeEventListener('change', changed);
    arm();
    onChange();
  };
  arm();
  return () => { stopped = true; query.removeEventListener('change', changed); };
}
