export class Timeline {
  hour = 20;
  playing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(h: number) => void>();
  subscribe(fn: (h: number) => void) {
    this.listeners.add(fn);
    fn(this.hour);
    return () => {
      this.listeners.delete(fn);
    };
  }
  setHour(h: number) {
    this.hour = Math.max(0, Math.min(23, Math.floor(h)));
    this.listeners.forEach((fn) => fn(this.hour));
  }
  play(seconds = 1) {
    this.pause();
    this.playing = true;
    this.timer = setInterval(
      () => this.setHour((this.hour + 1) % 24),
      seconds * 1000,
    );
  }
  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.playing = false;
  }
  dispose() {
    this.pause();
    this.listeners.clear();
  }
}
