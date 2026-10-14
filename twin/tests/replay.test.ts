import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {stubRaf} from './raf-test-helper';
beforeEach(stubRaf);afterEach(()=>vi.unstubAllGlobals());
import { DashboardStore } from "../src/state/store";
import { MockAdapter, mockReplay } from "../src/data/adapters";
import {
  sampleFrame,
  observedPoints,
  clockTime,
} from "../src/data/interpolate";

it("timeline click seeks smoothly using the same fractional cursor", () => {
  vi.useFakeTimers();
  const store = new DashboardStore(new MockAdapter(), undefined, {query:'?at=2026-10-12T14:00'});
  store.seekHour(10);
  expect(store.getSnapshot().time).toBe(14);
  vi.advanceTimersByTime(250);
  expect(store.getSnapshot().time).toBeGreaterThan(10);
  expect(store.getSnapshot().time).toBeLessThan(14);
  vi.advanceTimersByTime(300);
  expect(store.getSnapshot().time).toBe(10);
  store.dispose();
  vi.useRealTimers();
});

it('plays a complete 24h from 22:00, wraps date/hour and keeps the same data until reset',async()=>{
 vi.useFakeTimers();
 const store=new DashboardStore(new MockAdapter(),undefined,{query:'?at=2026-10-12T22:00'});await store.initialize();
 const data=store.getSnapshot().data;store.togglePlayback();
 vi.advanceTimersByTime(2000);expect(store.getSnapshot().time).toBeCloseTo(0,3);expect(new Date(store.getSnapshot().nowMs).getDate()).toBe(13);expect(store.getSnapshot().hour).toBe(0);
 vi.advanceTimersByTime(22016);expect(store.getSnapshot()).toMatchObject({time:22,hour:22,playing:false,playbackFinished:true,playbackElapsedHours:24});expect(store.getSnapshot().data).toBe(data);
 const end=store.getSnapshot().nowMs;vi.advanceTimersByTime(5000);expect(store.getSnapshot().nowMs).toBe(end);
 store.togglePlayback();expect(store.getSnapshot()).toMatchObject({time:22,playbackStartMs:null,playbackFinished:false,playing:false});expect(new Date(store.getSnapshot().nowMs).getDate()).toBe(12);store.dispose();vi.useRealTimers();
});
it('starts at the actual minute/second, pauses and resumes within the original 24h budget',async()=>{
 vi.useFakeTimers();const store=new DashboardStore(new MockAdapter(),undefined,{query:'?at=2026-10-12T22:23:05'});await store.initialize();store.setHour(5);store.togglePlayback();
 expect(store.getSnapshot().time).toBeCloseTo(22+23/60+5/3600);vi.advanceTimersByTime(1000);store.pause();const paused=store.getSnapshot().nowMs;const elapsed=store.getPlaybackFrame().elapsedHours;
 vi.advanceTimersByTime(5000);store.syncClock();expect(store.getSnapshot().nowMs).toBe(paused);store.togglePlayback();vi.advanceTimersByTime(16);expect(store.getPlaybackFrame().elapsedHours).toBeCloseTo(elapsed+0.016,6);
 vi.advanceTimersByTime(24000);expect(store.getSnapshot().playbackElapsedHours).toBe(24);expect(new Date(store.getSnapshot().nowMs).getDate()).toBe(13);expect(store.getSnapshot().time).toBeCloseTo(22+23/60+5/3600);store.dispose();vi.useRealTimers();
});
it('reset reads real now and resumes seconds; real midnight during playback cannot reload the pinned data',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,5,18,22));const source=new MockAdapter();source.loadScenario=vi.fn(source.loadScenario.bind(source));const store=new DashboardStore(source,undefined,{query:''});await store.initialize();const data=store.getSnapshot().data;store.togglePlayback();
 vi.setSystemTime(new Date(2026,5,19,1));vi.advanceTimersByTime(24016);expect(store.getSnapshot().playbackFinished).toBe(true);expect(store.getSnapshot().data).toBe(data);expect(source.loadScenario).toHaveBeenCalledTimes(1);
 store.togglePlayback();await Promise.resolve();expect(store.getSnapshot().scenario).toBe('abstain');expect(store.getSnapshot().hour).toBe(1);const now=store.getSnapshot().nowMs;vi.advanceTimersByTime(1000);store.syncClock();expect(store.getSnapshot().nowMs-now).toBe(1000);store.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
});
it('interpolates 23:30 into the reused midnight sample without exposing hour 24',()=>{
 const data=mockReplay('normal');expect(sampleFrame(data,23.5).hour.point_kw).toBe((data.hours[23].point_kw+data.hours[0].point_kw)/2);expect(sampleFrame(data,24).hour).toEqual(sampleFrame(data,0).hour);
});
it("interpolates load, floors and flows and clips observed curve at cursor", () => {
  const data = mockReplay("normal");
  const frame = sampleFrame(data, 10.5);
  expect(frame.hour.point_kw).toBe(
    (data.hours[10].point_kw + data.hours[11].point_kw) / 2,
  );
  expect(frame.hour.floors_kw[5]).toBe(
    (data.hours[10].floors_kw[5] + data.hours[11].floors_kw[5]) / 2,
  );
  expect(frame.hour.grid_kw).toBe(
    (data.hours[10].grid_kw + data.hours[11].grid_kw) / 2,
  );
  expect(observedPoints(data, 10.5).at(-1)![0]).toBe(10.5);
  expect(observedPoints(data, 10.5).every(([time]) => time <= 10.5)).toBe(true);
  expect(clockTime(10.5)).toBe("10:30:00");
});
