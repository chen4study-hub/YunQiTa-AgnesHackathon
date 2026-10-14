import {it,expect} from 'vitest';
import {mockReplay} from '../src/data/adapters';
import {overviewWindow} from '../src/data/overviewForecast';
it('no playback/reset is a fresh two-measurement rolling window, with realized red gates',()=>{
 const data=mockReplay('normal');for(const time of [0,11.4,23]){const origin=Math.floor(time),view=overviewWindow(data,time);expect(view.slots.map(p=>p.t)).toEqual(Array.from({length:26},(_,i)=>origin-1+i));expect(view.slots.filter(p=>p.actual!==null)).toHaveLength(2);for(const slot of view.slots.slice(2)){expect(slot.actual).toBeNull();expect(slot.realized_abstain).toBe(data.hours[slot.t%24].abstain);}}
 const end=overviewWindow(data,0,{startHour:23,elapsedHours:24});expect(end.slots.every(p=>p.actual!==null)).toBe(true);const reset=overviewWindow(data,11);expect(reset.slots[0].t).toBe(10);expect(reset.slots.filter(p=>p.actual!==null)).toHaveLength(2);
});
