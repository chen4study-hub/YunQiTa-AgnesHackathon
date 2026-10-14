import {it,expect} from 'vitest';
import {mockReplay} from '../src/data/adapters';
import {predictionWindow} from '../src/data/forecast';
import {overviewForecastOption} from '../src/components/ReplayChart';
it('target-hour gate is stable across origins and midnight, without replacing origin forecast gate',()=>{
 const data=mockReplay('normal');data.hours.forEach((hour,i)=>{hour.abstain=i%3===0;hour.forecast_24h.forEach(p=>p.abstain=i%2===0);});const before=structuredClone(data);
 for(let origin=0;origin<24;origin++)for(const point of predictionWindow(data,origin).forecast_24h){expect(point.realized_abstain).toBe(data.hours[point.t%24].abstain);expect(point.abstain).toBe(origin%2===0);}
 expect(predictionWindow(data,23).forecast_24h[0]).toMatchObject({t:24,realized_abstain:true,abstain:false});expect(data).toEqual(before);
});
it('chart red regions and scatter follow target gates even when origin forecast abstain disagrees',()=>{
 const data=mockReplay('normal');data.hours.forEach(h=>{h.abstain=false;h.forecast_24h.forEach(p=>p.abstain=true);});data.hours[0].abstain=true;
 const option=overviewForecastOption(data,23);const series=option.series as any[];expect(series[2].markArea.data).toHaveLength(1);expect(series[3].data.map((p:any)=>p[0])).toEqual(['24']);expect((option.tooltip as any).formatter([{axisValue:'24'}])).toContain('拒绝预测');expect((option.tooltip as any).formatter([{axisValue:'25'}])).not.toContain('拒绝预测');
});
