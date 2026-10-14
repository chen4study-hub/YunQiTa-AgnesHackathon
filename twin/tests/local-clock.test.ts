import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {stubRaf} from './raf-test-helper';
beforeEach(stubRaf);
import {DashboardStore} from '../src/state/store';
import {MockAdapter} from '../src/data/adapters';
import {localClockText, localDateKey, parseLocalAt} from '../src/config/localClock';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('defaults to browser local date/hour, ticks seconds when not playing and switches hourly data at the boundary',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,13,59,58));const store=new DashboardStore(new MockAdapter(),undefined,{query:''});
 expect(store.getSnapshot().time).toBe(13);await store.initialize();vi.advanceTimersByTime(1000);
 expect(localClockText(store.getSnapshot().nowMs)).toBe('13:59:59');expect(store.getSnapshot().hour).toBe(13);vi.advanceTimersByTime(1000);
 expect(localClockText(store.getSnapshot().nowMs)).toBe('14:00:00');expect(store.getSnapshot()).toMatchObject({hour:14,time:14,playing:false});store.dispose();expect(vi.getTimerCount()).toBe(0);
});
it('catches up after background/system clock changes and wraps midnight locally',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,23,59,59));const store=new DashboardStore(new MockAdapter(),undefined,{query:''});await store.initialize();vi.advanceTimersByTime(1000);
 expect(localDateKey(store.getSnapshot().nowMs)).toBe('2026-10-13');expect(store.getSnapshot().hour).toBe(0);vi.setSystemTime(new Date(2026,9,13,9,23,5));store.syncClock();expect(store.getSnapshot().hour).toBe(9);expect(localClockText(store.getSnapshot().nowMs)).toBe('09:23:05');store.dispose();
});
it('playback date advances independently, paused date holds until reset to real now',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,14,23,5));const store=new DashboardStore(new MockAdapter(),undefined,{query:''});await store.initialize();store.togglePlayback();vi.advanceTimersByTime(1000);expect(Math.abs(store.getPlaybackFrame().time-(14+23/60+5/3600+1))).toBeLessThan(0.03);store.pause();const paused=store.getSnapshot().nowMs;vi.advanceTimersByTime(1000);expect(store.getSnapshot().nowMs).toBe(paused);store.resetPlayback();expect(localClockText(store.getSnapshot().nowMs)).toBe('14:23:07');store.dispose();
});
it('hidden at freezes local wall time and data hour; invalid or timezone-bearing dates fall back',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,9,0));const store=new DashboardStore(new MockAdapter(),undefined,{query:'?at=2026-10-12T14:23:05'});await store.initialize();vi.advanceTimersByTime(5000);expect(store.getSnapshot().hour).toBe(14);expect(localClockText(store.getSnapshot().nowMs)).toBe('14:23:05');store.dispose();
 for(const v of ['2026-02-30T14:00','2026-10-12T24:00','2026-10-12T14:60','2026-10-12T14:00Z','bad'])expect(parseLocalAt(v)).toBeNull();
 expect(localDateKey(parseLocalAt('2026-10-12T14:00')!)).toBe('2026-10-12');
});
