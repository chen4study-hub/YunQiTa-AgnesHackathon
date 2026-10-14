export class RotationPolicy {
  enabled = true;
  private dragging = false;
  private resumeAt = 0;
  start() {
    this.dragging = true;
  }
  end(now: number) {
    this.dragging = false;
    this.resumeAt = now + 3000;
  }
  reset() {
    this.dragging = false;
    this.resumeAt = 0;
  }
  active(now: number, reduced: boolean, transitioning: boolean) {
    return (
      this.enabled &&
      !reduced &&
      !transitioning &&
      !this.dragging &&
      now >= this.resumeAt
    );
  }
}
