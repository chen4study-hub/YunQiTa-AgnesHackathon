import type { ReplayData, ModelCard, TwinDataSource } from "../data/types";
import { resolveClock, localDateKey, type ClockOptions } from '../config/localClock';
import { scenarioForDate, scenarioOverride } from '../config/chinaCalendar';
import {bindDisplayClock} from '../config/displayClock';
import { loadLiveSchedule, liveScheduleKey, type LiveSchedule, type ScheduleLoader } from '../data/liveSchedule';
import { TabTimeSync, elapsedAt, sharedWallNow, type SharedTimeState, type TabSyncOptions } from './tabSync';

export type Scenario = "normal" | "peak" | "abstain";
export type Page =
  "overview" | "forecast" | "agent" | "floors" | "energy" | "about";
export interface DashboardState {
  page: Page;
  scenario: Scenario;
  hour: number; // selected hour
  time: number; // hourly data cursor; wall clock uses an integer hour, playback may interpolate
  /** Manual hour selection stays pinned until an explicit return to the current time. */
  followingCurrent: boolean;
  /** Viewed local time in epoch milliseconds. Read the wall clock only via getRealNowMs(). */
  nowMs: number;
  selectedFloor: number | null;
  switches: {
    mode: "heat" | "real";
    xray: boolean;
    exploded: boolean;
    autoRotate: boolean;
    quality: "high" | "low";
  };
  playing: boolean;
  /** Non-null from playback start through pause/completion; nowMs is then the displayed playback date. */
  playbackStartMs: number | null;
  playbackElapsedHours: number;
  playbackFinished: boolean;
  loading: boolean;
  loadError: boolean;
  data: ReplayData | null;
  modelCard: ModelCard | null;
  /** Validated current-hour responses, scoped by scenario/building/origin. Never mutate replay data. */
  liveSchedules: Readonly<Record<string, LiveSchedule>>;
}

export interface PlaybackFrame {
  nowMs: number;
  time: number;
  elapsedHours: number;
}
export class DashboardStore {
  private state: DashboardState = {
    page: "overview",
    scenario: "normal",
    hour: 0,
    time: 0,
    followingCurrent: true,
    nowMs: 0,
    selectedFloor: null,
    switches: {
      mode: "heat",
      xray: false,
      exploded: false,
      autoRotate: true,
      quality: "high",
    },
    playing: false,
    playbackStartMs: null,
    playbackElapsedHours: 0,
    playbackFinished: false,
    loading: false,
    loadError: false,
    data: null,
    modelCard: null,
    liveSchedules: {},
  };
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(frame: PlaybackFrame) => void>();
  private playbackFrame!: PlaybackFrame;
  /** Calendar of the selected timeline cell, held even if the real clock crosses midnight. */
  private selectedDayMs: number | null = null;
  private playbackRaf = 0;
  private notifiedFrame: PlaybackFrame | null = null;
  getPlaybackFrame = () => {
    if (this.notifiedFrame) return this.notifiedFrame;
    if (this.state.playing && this.state.playbackStartMs !== null)
      return this.frameAt(this.state.playbackStartMs, elapsedAt(this.sharedTime(), this.wallNow()));
    return this.playbackFrame;
  };
  /** Actual local clock, independent of the selected or paused display time. */
  getRealNowMs = () => this.clock.fixedAt ?? (this.clock.now() + (this.syncOptions.offsetMs?.() ?? 0));
  /** 3D samples continuous time without React or hourly snapshot rounding. */
  getContinuousTime = () => {
    if (this.state.playbackStartMs !== null || !this.state.followingCurrent) return this.getPlaybackFrame().time;
    const date = new Date(this.getRealNowMs());
    return date.getHours()+date.getMinutes()/60+date.getSeconds()/3600+date.getMilliseconds()/3_600_000;
  };
  /** All subscribers receive the exact same sampled frame, even across an hourly boundary. */
  private publishFrame(frame = this.playbackFrame) {
    this.notifiedFrame = frame;
    try { this.frameListeners.forEach(listener => listener(frame)); }
    finally { this.notifiedFrame = null; }
  }
  subscribePlayback = (listener: (frame: PlaybackFrame) => void) => {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  };
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private lastTick = 0;
  private seekTarget: number | null = null;
  private disposed = false;
  private scheduleRequests = new Map<string, Promise<LiveSchedule | null>>();
  private clock: ReturnType<typeof resolveClock>;
  private wallTimer: ReturnType<typeof setInterval> | undefined;
  private override: Scenario | null;
  private calendarDate: string;
  private unbindDisplayClock:()=>void;
  private tabSync: TabTimeSync;
  private runStartedAtMs: number | null = null;
  private runElapsedHours = 0;
  private syncOptions: TabSyncOptions;
  private wallNow = () => sharedWallNow(this.syncOptions);
  constructor(private source: TwinDataSource, private scheduleLoader: ScheduleLoader = loadLiveSchedule, options: ClockOptions = {}, syncOptions: TabSyncOptions = {}) {
    this.syncOptions = syncOptions;
    this.clock = resolveClock(options);
    const nowMs = this.getRealNowMs();
    const hour = new Date(nowMs).getHours();
    this.override = scenarioOverride(this.clock.query);
    this.calendarDate = localDateKey(nowMs);
    this.state = { ...this.state, nowMs, hour, time: hour, scenario: this.override ?? scenarioForDate(nowMs) };
    this.playbackFrame = {nowMs, time:hour, elapsedHours:0};
    this.unbindDisplayClock=bindDisplayClock(()=>this.playbackFrame.nowMs);
    this.tabSync = new TabTimeSync(this.sharedTime, this.receiveTime, syncOptions);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.resumeClock);
    if (typeof window !== 'undefined') window.addEventListener('pageshow', this.resumeClock);
  }
  private sharedTime = (): SharedTimeState => ({
    followingCurrent: this.state.followingCurrent,
    selectedDayMs: this.selectedDayMs,
    selectedTime: this.seekTarget ?? this.state.time,
    playbackStartMs: this.state.playbackStartMs,
    elapsedHours: this.state.playing ? this.runElapsedHours : this.state.playbackElapsedHours,
    runStartedAtMs: this.runStartedAtMs,
    playing: this.state.playing,
    finished: this.state.playbackFinished,
  });
  /** Broadcast before any local subscriber can do chart/React work. */
  private commandTime(shared: SharedTimeState) {
    this.tabSync.publish(shared);
    this.receiveTime(shared);
  }
  private clearPlaybackTimers() {
    if (this.playbackRaf) cancelAnimationFrame(this.playbackRaf);
    this.playbackRaf = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.seekTarget = null;
  }
  private receiveTime = (shared: SharedTimeState) => {
    if (this.disposed) return;
    this.clearPlaybackTimers();
    this.selectedDayMs = shared.selectedDayMs;
    this.runStartedAtMs = shared.runStartedAtMs;
    this.runElapsedHours = shared.elapsedHours;
    const elapsed = elapsedAt(shared, this.wallNow());
    const nowMs = this.getRealNowMs();
    const time = shared.followingCurrent ? new Date(nowMs).getHours() : shared.selectedTime;
    const frame = shared.playbackStartMs === null
      ? {nowMs, time, elapsedHours: 0}
      : this.frameAt(shared.playbackStartMs, elapsed);
    this.playbackFrame = frame;
    // One immediate, complete snapshot: never notify with the previous tab's frame.
    this.update({followingCurrent: shared.followingCurrent, playing: shared.playing,
      playbackStartMs: shared.playbackStartMs, playbackElapsedHours: elapsed,
      playbackFinished: shared.finished, nowMs: frame.nowMs, time: frame.time, hour: Math.floor(frame.time)});
    if (shared.playing) {
      this.publishFrame();
      this.startPlaybackLoop();
    } else if (shared.playbackStartMs === null) {
      this.syncClock();
      this.startClock();
    }
  };
  private resumeClock = () => {
    if (this.disposed) return;
    if (this.state.playing) this.refreshPlayback();
    else this.syncClock();
    this.tabSync.request();
  };
  /** Re-read the actual clock rather than incrementing a counter (background tabs catch up). */
  syncClock() {
    if (this.disposed || !this.state.followingCurrent || this.state.playbackStartMs !== null) return;
    const nowMs = this.getRealNowMs();
    const hour = new Date(nowMs).getHours();
    this.update({ nowMs, hour, time: hour });
    const dateKey = localDateKey(nowMs);
    if (dateKey !== this.calendarDate) {
      this.calendarDate = dateKey;
      const scenario = this.override ?? scenarioForDate(nowMs);
      if (scenario !== this.state.scenario) {
        if (this.state.data || this.state.loading) void this.loadScenario(scenario, true);
        else this.update({scenario});
      }
    }
  }
  private startClock() {
    if (this.disposed || this.wallTimer !== undefined || this.clock.fixedAt !== null) return;
    this.wallTimer = setInterval(() => this.syncClock(), 1000);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<DashboardState>) {
    this.state = { ...this.state, ...patch };
    if (!this.state.playing) {
      let nowMs = this.state.nowMs;
      if (!this.state.followingCurrent && this.state.playbackStartMs === null && this.selectedDayMs !== null) {
        const selected = new Date(this.selectedDayMs);
        selected.setHours(Math.floor(this.state.time), 0, 0, 0);
        selected.setMilliseconds(Math.round((this.state.time % 1) * 3_600_000));
        nowMs = selected.getTime();
        // Publish the same viewed instant to both React pages and frame subscribers.
        this.state = { ...this.state, nowMs };
      }
      this.playbackFrame = {nowMs,time:this.state.time,elapsedHours:this.state.playbackElapsedHours};
      this.publishFrame();
    }
    this.listeners.forEach((listener) => listener());
  }
  /** Select only the visible hour; stale responses stay cached but never leak into other origins. */
  getLiveSchedule(scenario = this.state.scenario, index = Math.floor(this.state.time), data = this.state.data): LiveSchedule | null {
    const hour = data?.hours[index];
    return data && hour ? this.state.liveSchedules[liveScheduleKey(scenario,data.meta.building_id,hour.t,localDateKey(this.playbackFrame.nowMs))] ?? null : null;
  }
  async ensureLiveSchedule(): Promise<LiveSchedule | null> {
    const {data,scenario,time,hour,loading,playing} = this.state;
    if(this.disposed || this.state.playbackStartMs !== null || !data || loading || playing || time !== hour || !Number.isInteger(time))return null;
    const index=Math.floor(time),origin=data.hours[index]?.t;
    if(!origin)return null;
    const displayDate=localDateKey(this.playbackFrame.nowMs);
    const key=liveScheduleKey(scenario,data.meta.building_id,origin,displayDate);
    const cached=this.state.liveSchedules[key];if(cached)return cached;
    const pending=this.scheduleRequests.get(key);if(pending)return pending;
    // Install the promise before the loader runs. Null/failure is also de-duplicated: no automatic re-dispatch.
    const request=Promise.resolve().then(()=>this.scheduleLoader(data,index,scenario,displayDate)).catch(()=>null).then(result=>{
      if(this.disposed || !result || result.source !== 'schedule' || result.t !== origin)return null;
      const entries=Object.entries({...this.state.liveSchedules,[key]:result}).slice(-72);
      this.update({liveSchedules:Object.fromEntries(entries)});
      return result;
    });
    this.scheduleRequests.set(key,request);
    if(this.scheduleRequests.size>72)this.scheduleRequests.delete(this.scheduleRequests.keys().next().value!);
    return request;
  }
  setPage(page: Page) {
    this.update({ page });
  }
  setHour(hour: number) {
    if (!Number.isFinite(hour)) return;
    this.commandTime({...this.sharedTime(), selectedDayMs: this.getPlaybackFrame().nowMs,
      selectedTime: Math.max(0, Math.min(23, hour)), followingCurrent: false,
      playbackStartMs: null, elapsedHours: 0, runStartedAtMs: null, playing: false, finished: false});
  }
  seekHour(hour: number) {
    if (!Number.isFinite(hour)) return;
    const target = Math.max(0, Math.min(23, hour));
    const shared = {...this.sharedTime(), selectedDayMs: this.getPlaybackFrame().nowMs,
      selectedTime: target, followingCurrent: false, playbackStartMs: null,
      elapsedHours: 0, runStartedAtMs: null, playing: false, finished: false};
    this.tabSync.publish(shared);
    this.selectedDayMs = shared.selectedDayMs;
    this.cancelPlayback();
    const start = this.state.time;
    let elapsed = 0;
    this.update({ hour: target, followingCurrent: false });
    // Other tabs adopt the selected hour immediately; this tab may animate the seek.
    this.seekTarget = target;
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      elapsed += Math.min(50, Math.max(0, now - this.lastTick));
      this.lastTick = now;
      const u = Math.min(1, elapsed / 500);
      this.update({ time: start + (target - start) * u * u * (3 - 2 * u) });
      if (u === 1) this.stopPlayback(false);
    }, 16);
  }
  selectFloor(floor: number | null) {
    if (
      floor === null ||
      (Number.isInteger(floor) && floor >= 1 && floor <= 40)
    )
      this.update({ selectedFloor: floor });
  }
  setSwitch<K extends keyof DashboardState["switches"]>(
    key: K,
    value: DashboardState["switches"][K],
  ) {
    this.update({ switches: { ...this.state.switches, [key]: value } });
  }
  async loadScenario(scenario: Scenario, preserveTime = false) {
    if (!preserveTime) {
      this.cancelPlayback();
      this.tabSync.publish();
    }
    const token = ++this.generation;
    this.update({
      scenario,
      loading: true,
      loadError: false,
      time: this.state.time,
    });
    try {
      const data = await this.source.loadScenario(scenario);
      if (token !== this.generation) return;
      this.update({ data, loading: false, loadError: false });
    } catch {
      if (token !== this.generation) return;
      this.update({ data: null, loading: false, loadError: true });
    }
  }
  async initialize() {
    this.syncClock();
    this.startClock();
    try {
      const modelCard = await this.source.loadModelCard();
      if (this.disposed) return;
      this.update({ modelCard });
    } catch {
      if (this.disposed) return;
      this.update({ modelCard: null, loading: false, loadError: true });
      return;
    }
    this.syncClock();
    await this.loadScenario(this.state.scenario, true);
    if (!this.disposed) this.tabSync.request();
  }
  retryLoad() { return this.initialize(); }
  private cancelPlayback() {
    this.stopPlayback(true);
    this.update({playbackStartMs:null, playbackElapsedHours:0, playbackFinished:false});
  }
  returnToCurrent() {
    this.commandTime({followingCurrent: true, selectedDayMs: null, selectedTime: new Date(this.getRealNowMs()).getHours(),
      playbackStartMs: null, elapsedHours: 0, runStartedAtMs: null, playing: false, finished: false});
  }
  resetPlayback() {
    this.returnToCurrent();
  }
  togglePlayback() {
    if (this.state.playbackFinished) { this.resetPlayback(); return; }
    if (this.state.playing) { this.pause(); return; }
    const start = this.state.playbackStartMs ?? this.getRealNowMs();
    const elapsed = this.state.playbackElapsedHours;
    this.commandTime({...this.sharedTime(), followingCurrent: false, playbackStartMs: start,
      elapsedHours: elapsed, runStartedAtMs: this.wallNow(), playing: true, finished: false});
  }
  private refreshPlayback() {
    if (!this.state.playing || this.state.playbackStartMs === null) return;
    const hours = elapsedAt(this.sharedTime(), this.wallNow());
    if (hours >= 24) {
      this.commandTime({...this.sharedTime(), elapsedHours: 24, runStartedAtMs: null, playing: false, finished: true});
    } else this.applyPlayback(this.state.playbackStartMs, hours);
  }
  private startPlaybackLoop() {
    if (this.playbackRaf) cancelAnimationFrame(this.playbackRaf);
    const tick = () => {
      if (!this.state.playing || this.disposed) return;
      this.refreshPlayback();
      if (this.state.playing) this.playbackRaf = requestAnimationFrame(tick);
    };
    this.refreshPlayback();
    if (this.state.playing) this.playbackRaf = requestAnimationFrame(tick);
  }
  private frameAt(start: number, elapsed: number): PlaybackFrame {
    const nowMs = start + elapsed * 3_600_000;
    const date = new Date(nowMs);
    const time = date.getHours() + date.getMinutes()/60 + date.getSeconds()/3600 + date.getMilliseconds()/3_600_000;
    return {nowMs,time,elapsedHours:elapsed};
  }
  private applyPlayback(start: number, elapsed: number) {
    const frame = this.frameAt(start, elapsed);
    const {nowMs,time} = frame;
    this.playbackFrame = frame;
    // Publish integer data cursor only on an hourly/date boundary; UI receives exact fractional time.
    if (!this.state.playing || Math.floor(time) !== this.state.hour || localDateKey(nowMs) !== localDateKey(this.state.nowMs)) {
      this.update({nowMs, time:this.state.playing ? Math.floor(time) : time, hour:Math.floor(time), playbackStartMs:start, playbackElapsedHours:elapsed});
    }
    this.publishFrame(frame);
  }
  pause() {
    const shared = this.sharedTime();
    this.commandTime({...shared, selectedTime: this.getPlaybackFrame().time,
      elapsedHours: elapsedAt(shared, this.wallNow()), runStartedAtMs: null, playing: false});
  }
  private stopPlayback(sample: boolean) {
    if (sample && this.state.playing && this.state.playbackStartMs !== null) {
      this.applyPlayback(this.state.playbackStartMs, elapsedAt(this.sharedTime(), this.wallNow()));
    }
    if (this.playbackRaf) cancelAnimationFrame(this.playbackRaf);
    this.playbackRaf = 0;
    if (this.state.playing) {
      const frame = this.playbackFrame;
      this.update({playing:false,nowMs:frame.nowMs,time:frame.time,hour:Math.floor(frame.time),playbackElapsedHours:frame.elapsedHours});
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.seekTarget = null;
    this.runStartedAtMs = null;
    this.runElapsedHours = this.playbackFrame.elapsedHours;
    this.update({ playing: false });
  }
  dispose() {
    this.disposed = true;
    this.tabSync.close();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.resumeClock);
    if (typeof window !== 'undefined') window.removeEventListener('pageshow', this.resumeClock);
    this.unbindDisplayClock();
    this.scheduleRequests.clear();
    if (this.wallTimer !== undefined) clearInterval(this.wallTimer);
    this.wallTimer = undefined;
    this.stopPlayback(false);
    ++this.generation;
    this.listeners.clear();
    this.frameListeners.clear();
  }
}
