import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {stubRaf} from './raf-test-helper';
import {DashboardStore} from '../src/state/store';
import {MockAdapter} from '../src/data/adapters';
beforeEach(()=>{vi.useFakeTimers();stubRaf();});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('UI receives frames but the global store only publishes crossing hours',async()=>{
 const store=new DashboardStore(new MockAdapter(),undefined,{query:'?at=2026-10-12T11:25'});await store.initialize();store.togglePlayback();const global=vi.fn(),ui=vi.fn();store.subscribe(global);store.subscribePlayback(ui);vi.advanceTimersByTime(500);expect(global).not.toHaveBeenCalled();expect(ui.mock.calls.length).toBeGreaterThan(25);expect(store.getSnapshot().time).toBeCloseTo(11+25/60);expect(store.getContinuousTime()).toBeCloseTo(11+25/60+0.496,2);vi.advanceTimersByTime(1000);expect(global).toHaveBeenCalledTimes(1);expect(store.getSnapshot().time).toBe(12);store.dispose();
});
it('non-playing scene time includes true minutes/seconds, independent of integer cards',()=>{
 const store=new DashboardStore(new MockAdapter(),undefined,{query:'?at=2026-10-12T11:25:30'});expect(store.getSnapshot().time).toBe(11);expect(store.getContinuousTime()).toBeCloseTo(11+25/60+30/3600);store.dispose();
});
