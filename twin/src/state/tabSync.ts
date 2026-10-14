/** Time controls only: no page, scene, data or chat state crosses this channel. */
export interface SharedTimeState {
  followingCurrent: boolean;
  selectedDayMs: number | null;
  selectedTime: number;
  playbackStartMs: number | null;
  elapsedHours: number;
  runStartedAtMs: number | null;
  playing: boolean;
  finished: boolean;
}
export interface TimeChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}
export interface TabSyncOptions {
  channelFactory?: (name: string) => TimeChannel;
  wallNow?: () => number;
  /** Future /ops/time integration: server epoch minus local epoch, in milliseconds. */
  offsetMs?: () => number;
}
export function sharedWallNow(options: TabSyncOptions): number {
  return (options.wallNow ?? Date.now)() + (options.offsetMs?.() ?? 0);
}
export function elapsedAt(state: SharedTimeState, wallMs: number): number {
  return Math.min(
    24,
    state.elapsedHours +
      (state.playing && state.runStartedAtMs !== null
        ? Math.max(0, wallMs - state.runStartedAtMs) / 1000
        : 0),
  );
}
interface Revision {
  counter: number;
  sender: string;
}
const newer = (a: Revision, b: Revision) =>
  a.counter > b.counter || (a.counter === b.counter && a.sender > b.sender);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const epoch = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= 8.64e15;
export function isSharedTimeState(value: unknown): value is SharedTimeState {
  if (!record(value)) return false;
  return (
    typeof value.followingCurrent === "boolean" &&
    typeof value.playing === "boolean" &&
    typeof value.finished === "boolean" &&
    (value.selectedDayMs === null || epoch(value.selectedDayMs)) &&
    (value.playbackStartMs === null || epoch(value.playbackStartMs)) &&
    (value.runStartedAtMs === null || epoch(value.runStartedAtMs)) &&
    typeof value.selectedTime === "number" &&
    Number.isFinite(value.selectedTime) &&
    value.selectedTime >= 0 &&
    value.selectedTime < 24 &&
    typeof value.elapsedHours === "number" &&
    Number.isFinite(value.elapsedHours) &&
    value.elapsedHours >= 0 &&
    value.elapsedHours <= 24 &&
    (!value.playing ||
      (value.playbackStartMs !== null &&
        value.runStartedAtMs !== null &&
        !value.finished &&
        !value.followingCurrent)) &&
    (value.playing || value.runStartedAtMs === null) &&
    (!value.finished ||
      (value.elapsedHours === 24 &&
        value.playbackStartMs !== null &&
        !value.playing)) &&
    (!value.followingCurrent ||
      (value.playbackStartMs === null && !value.playing))
  );
}
const CHANNEL = "yunqi-dashboard-time-v1";
/** Lamport order resolves simultaneous controls; snapshots are targeted and never echoed. */
export class TabTimeSync {
  private channel: TimeChannel | undefined;
  private id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  private revision: Revision = { counter: 0, sender: "" };
  constructor(
    private read: () => SharedTimeState,
    private apply: (state: SharedTimeState) => void,
    options: TabSyncOptions = {},
  ) {
    const factory =
      options.channelFactory ??
      (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
        ? (name: string) => new BroadcastChannel(name)
        : undefined);
    if (!factory) return;
    try {
      this.channel = factory(CHANNEL);
      this.channel.addEventListener("message", this.receive);
      this.request();
    } catch {
      this.channel?.close();
      this.channel = undefined;
    }
  }
  request() {
    this.send({ version: 1, type: "request", sender: this.id });
  }
  publish(state = this.read()) {
    this.revision = { counter: this.revision.counter + 1, sender: this.id };
    this.sendState(undefined, state);
  }
  private send(message: unknown) {
    // A blocked/closed channel must not prevent local time controls.
    try {
      this.channel?.postMessage(message);
    } catch {
      /* local-only fallback */
    }
  }
  private sendState(target?: string, state = this.read()) {
    this.send({
      version: 1,
      type: "state",
      sender: this.id,
      target,
      revision: this.revision,
      state,
    });
  }
  private receive = ({ data }: MessageEvent) => {
    if (
      !record(data) ||
      data.version !== 1 ||
      typeof data.sender !== "string" ||
      data.sender === this.id
    )
      return;
    if (data.type === "request") {
      this.sendState(data.sender);
      return;
    }
    if (
      data.type !== "state" ||
      (data.target !== undefined && data.target !== this.id) ||
      !record(data.revision) ||
      !Number.isSafeInteger(data.revision.counter) ||
      (data.revision.counter as number) < 0 ||
      typeof data.revision.sender !== "string" ||
      !isSharedTimeState(data.state)
    )
      return;
    const revision = data.revision as unknown as Revision;
    if (!newer(revision, this.revision)) return;
    this.revision = revision;
    this.apply(data.state);
  };
  close() {
    this.channel?.removeEventListener("message", this.receive);
    this.channel?.close();
    this.channel = undefined;
  }
}
