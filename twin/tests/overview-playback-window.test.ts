import {expect,it} from 'vitest';
import {mockReplay} from '../src/data/adapters';
import {overviewWindow,playbackWindowGates} from '../src/data/overviewForecast';
import {overviewForecastOption} from '../src/components/ReplayChart';
it('fixed axis and gates persist for all 24 playback hours; passed slots become facts',()=>{
 const data=mockReplay('normal');data.hours.forEach((hour,index)=>{hour.abstain=index%3===0;hour.actual_kw=1000+index;hour.forecast_24h.forEach(p=>{p.point_kw=10000+index*100+p.horizon;});});
 const first=overviewWindow(data,23,{startHour:23,elapsedHours:0});
 for(let elapsedHours=0;elapsedHours<=24;elapsedHours++){
  const view=overviewWindow(data,(23+elapsedHours)%24,{startHour:23,elapsedHours});expect(view.slots.map(p=>p.t)).toEqual(first.slots.map(p=>p.t));expect(view.slots.map(p=>p.realized_abstain)).toEqual(first.slots.map(p=>p.realized_abstain));
  for(const slot of view.slots.slice(2))if(slot.t<=view.head)expect(slot.actual).toBe(data.hours[slot.t%24].actual_kw);else {expect(slot.actual).toBeNull();expect(slot.point).toBe(10000+((23+elapsedHours)%24)*100+slot.t-view.head);}
  const series=overviewForecastOption(data,(23+elapsedHours)%24,{startHour:23,elapsedHours}).series as any[];expect(series[2].markArea.data).toEqual((overviewForecastOption(data,23,{startHour:23,elapsedHours:0}).series as any[])[2].markArea.data);
 }
 const end=overviewWindow(data,23,{startHour:23,elapsedHours:24});expect(end.slots.every(p=>p.actual!==null&&p.point===null&&p.lower===null&&p.upper===null)).toBe(true);
});
it('fixed gates are an immutable starting-window snapshot even if later origin gates change',()=>{
 const data=mockReplay('normal');const first=overviewWindow(data,23,{startHour:23,elapsedHours:0});const gates=playbackWindowGates(data,23);
 expect(Object.isFrozen(gates)).toBe(true);data.hours.forEach(h=>{h.abstain=!h.abstain;});
 for(let elapsedHours=1;elapsedHours<=24;elapsedHours++)expect(overviewWindow(data,0,{startHour:23,elapsedHours}).slots.map(p=>p.realized_abstain)).toEqual(first.slots.map(p=>p.realized_abstain));
});
it('fractional start never marks future samples as actual and crossing midnight selects new origin',()=>{
 const data=mockReplay('normal');const p={startHour:23.5,elapsedHours:1};const view=overviewWindow(data,0.5,p);expect(view.head).toBe(24.5);expect(view.slots.find(p=>p.t===24)!.actual).toBe(data.hours[0].actual_kw);expect(view.slots.find(p=>p.t===25)!.actual).toBeNull();expect(view.slots.find(p=>p.t===25)!.point).toBe(data.hours[0].forecast_24h[0].point_kw);
});
