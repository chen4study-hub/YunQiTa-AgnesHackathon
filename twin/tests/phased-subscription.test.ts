import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {phasedSubscription} from '../src/state/phasedSubscription';
import {stubRaf} from './raf-test-helper';
import type {DashboardStore} from '../src/state/store';
beforeEach(()=>{vi.useFakeTimers();stubRaf();});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('startup commits spread across frames; stopping before a pending start flushes and cancels it',()=>{
 let state={playing:false,hour:11,nowMs:0};const listeners=new Set<()=>void>();const store={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);}} as unknown as DashboardStore;
 const one=phasedSubscription(store,1),six=phasedSubscription(store,6),a=vi.fn(),b=vi.fn();const stopA=one.subscribe(a),stopB=six.subscribe(b);
 state={...state,playing:true};listeners.forEach(fn=>fn());expect(a).not.toHaveBeenCalled();expect(b).not.toHaveBeenCalled();vi.advanceTimersByTime(16);expect(a).toHaveBeenCalledTimes(1);expect(b).not.toHaveBeenCalled();vi.advanceTimersByTime(80);expect(b).toHaveBeenCalledTimes(1);
 state={...state,playing:false};listeners.forEach(fn=>fn());state={...state,playing:true};listeners.forEach(fn=>fn());state={...state,playing:false};listeners.forEach(fn=>fn());expect(six.getSnapshot().playing).toBe(false);const calls=b.mock.calls.length;vi.advanceTimersByTime(120);expect(b).toHaveBeenCalledTimes(calls);stopA();stopB();
});
it('hourly commits spread across frames, discrete controls and stops flush immediately, unsubscription cancels',()=>{
 let state={playing:true,hour:11,nowMs:new Date(2026,9,12,11).getTime()};const listeners=new Set<()=>void>();const store={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);}} as unknown as DashboardStore;
 const one=phasedSubscription(store,1),three=phasedSubscription(store,3),a=vi.fn(),b=vi.fn();const stopA=one.subscribe(a),stopB=three.subscribe(b);state={...state,hour:12};listeners.forEach(fn=>fn());expect(a).not.toHaveBeenCalled();expect(b).not.toHaveBeenCalled();vi.advanceTimersByTime(16);expect(a).toHaveBeenCalledTimes(1);expect(b).not.toHaveBeenCalled();vi.advanceTimersByTime(32);expect(b).toHaveBeenCalledTimes(1);expect(three.getSnapshot().hour).toBe(12);
 state={...state,hour:13};listeners.forEach(fn=>fn());state={...state,playing:false};listeners.forEach(fn=>fn());expect(three.getSnapshot().playing).toBe(false);const calls=b.mock.calls.length;stopA();stopB();vi.advanceTimersByTime(100);expect(b).toHaveBeenCalledTimes(calls);expect(listeners.size).toBe(0);
});
