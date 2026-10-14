import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardStore } from '../src/state/store';
import { MockAdapter } from '../src/data/adapters';
import { localClockText, localDateKey } from '../src/config/localClock';
import { stubRaf } from './raf-test-helper';

let store: DashboardStore;
beforeEach(async () => {
  vi.useFakeTimers();
  stubRaf();
  vi.setSystemTime(new Date(2026, 9, 12, 23, 30));
  store = new DashboardStore(new MockAdapter(), undefined, { query: '' });
  await store.initialize();
});
afterEach(() => {
  store.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('publishes selected time atomically to snapshot and frame listeners, holding it through wall midnight and retries', async () => {
  const check = () => expect(store.getSnapshot().nowMs).toBe(store.getPlaybackFrame().nowMs);
  const off = store.subscribe(check), offFrame = store.subscribePlayback(check);
  store.setHour(23);
  const pinned = new Date(2026, 9, 12, 23).getTime();
  expect(store.getSnapshot().nowMs).toBe(pinned);
  vi.setSystemTime(new Date(2026, 9, 13, 0, 5));
  vi.advanceTimersByTime(4000);
  await store.retryLoad();
  store.setPage('agent');
  expect(store.getSnapshot()).toMatchObject({ nowMs: pinned, hour: 23, time: 23, followingCurrent: false });
  expect(store.getRealNowMs()).toBe(Date.now());
  expect(store.getRealNowMs()).not.toBe(pinned);
  store.returnToCurrent();
  expect(store.getSnapshot().nowMs).toBe(store.getRealNowMs());
  expect(localDateKey(store.getSnapshot().nowMs)).toBe('2026-10-13');
  expect(store.getSnapshot().followingCurrent).toBe(true);
  off(); offFrame();
});

it('selects on the displayed next day after a continuous midnight crossing and pause', () => {
  store.togglePlayback();
  vi.advanceTimersByTime(1216);
  const frame = store.getPlaybackFrame();
  expect(localDateKey(frame.nowMs)).toBe('2026-10-13');
  expect(frame.time).toBeGreaterThan(0.5);
  expect(frame.time).toBeLessThan(1);
  expect(store.getContinuousTime()).toBe(frame.time);
  store.pause();
  expect(store.getSnapshot().nowMs).toBe(store.getPlaybackFrame().nowMs);
  store.setHour(23);
  expect(store.getSnapshot().nowMs).toBe(new Date(2026, 9, 13, 23).getTime());
  vi.advanceTimersByTime(4000);
  store.syncClock();
  expect(localClockText(store.getSnapshot().nowMs)).toBe('23:00:00');
  expect(localDateKey(store.getSnapshot().nowMs)).toBe('2026-10-13');
  expect(store.getPlaybackFrame().nowMs).toBe(store.getSnapshot().nowMs);
  store.returnToCurrent();
  expect(localDateKey(store.getSnapshot().nowMs)).toBe('2026-10-12');
  expect(store.getSnapshot().nowMs).toBe(store.getRealNowMs());
});

it('smooth seeking publishes the same intermediate instant to pages and 3D', () => {
  store.seekHour(5);
  vi.advanceTimersByTime(250);
  expect(store.getSnapshot().nowMs).toBe(store.getPlaybackFrame().nowMs);
  expect(store.getPlaybackFrame().time).toBeGreaterThan(5);
  expect(store.getPlaybackFrame().time).toBeLessThan(23);
  vi.advanceTimersByTime(4000);
  expect(store.getSnapshot().nowMs).toBe(new Date(2026, 9, 12, 5).getTime());
});

it('initialize/retry start only one wall interval and cannot restart it after disposal', async () => {
  const timers = vi.getTimerCount();
  expect(timers).toBe(1);
  await Promise.all([store.initialize(), store.retryLoad(), store.retryLoad()]);
  expect(vi.getTimerCount()).toBe(timers);
  const listener = vi.fn();
  store.subscribe(listener);
  vi.advanceTimersByTime(1000);
  expect(listener).toHaveBeenCalledTimes(1);
  store.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await store.retryLoad();
  expect(vi.getTimerCount()).toBe(0);
});
