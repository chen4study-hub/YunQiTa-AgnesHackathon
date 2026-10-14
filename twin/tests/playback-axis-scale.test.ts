import {expect,it} from 'vitest';
import {mockReplay} from '../src/data/adapters';
import {overviewForecastOption} from '../src/components/ReplayChart';
import {playbackWindowScale,overviewWindow} from '../src/data/overviewForecast';
it('all 24h origins share a cached nice axis containing actuals, points and interval bounds; rolling stays adaptive',()=>{
 const data=mockReplay('normal');data.hours[16].forecast_24h[0].upper_kw=2400;data.hours[16].forecast_24h[0].point_kw=2300;
 const frozen=playbackWindowScale(data,11.4);expect(playbackWindowScale(data,11.4)).toBe(frozen);
 for(let elapsedHours=0;elapsedHours<=24;elapsedHours++){
 const playback={startHour:11.4,elapsedHours};expect(overviewForecastOption(data,0,playback).yAxis).toMatchObject(frozen);for(const slot of overviewWindow(data,0,playback).slots)for(const v of [slot.actual,slot.point,slot.lower,slot.upper])if(v!==null){expect(v).toBeGreaterThan(frozen.min);expect(v).toBeLessThan(frozen.max);}
 }
 expect(frozen.max).toBeGreaterThan(2400);expect((overviewForecastOption(data,0).yAxis as any).max).toBeLessThan(frozen.max);
});
