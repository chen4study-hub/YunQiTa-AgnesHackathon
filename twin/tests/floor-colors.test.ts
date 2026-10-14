import { expect, it } from 'vitest';
import { dailyFloorScale, floorScale, floorColor, FLOOR_COLORS, EQUIPMENT_COLOR } from '../src/ui/floorColors';
import { mockReplay } from '../src/data/adapters';
import { readFileSync } from 'node:fs';
import type { ReplayData } from '../src/data/types';
import { floorLoadOption } from '../src/pages/floors/FloorLoadChart';
it('uses office samples from 08 through 20 inclusive, fixed quantiles per day and continuous clamped anchors',()=>{
 const data=mockReplay('normal'); const values=data.hours.slice(8,21).flatMap(h=>h.floors_kw.filter((_,i)=>data.meta.floor_uses[i]==='office'));
 const scale=dailyFloorScale(data); expect(scale).toEqual(floorScale(values));expect(dailyFloorScale(data)).toBe(scale);
 expect(floorColor(scale.p10,scale)).toBe(FLOOR_COLORS[0]);expect(floorColor(scale.p50,scale)).toBe(FLOOR_COLORS[1]);expect(floorColor(scale.p90,scale)).toBe(FLOOR_COLORS[2]);
 expect(floorColor(-100,scale)).toBe(FLOOR_COLORS[0]);expect(floorColor(9999,scale)).toBe(FLOOR_COLORS[2]);
 expect(floorColor((scale.p10+scale.p50)/2,scale)).not.toBe(FLOOR_COLORS[0]);
 const bars=(floorLoadOption(data.hours[14].floors_kw,22,760,scale,data.meta.floor_uses).series as {data:{itemStyle:{color:string}}[]}[])[0].data;
 expect(bars.map(b=>b.itemStyle.color)).toEqual(data.hours[14].floors_kw.map((v,i)=>floorColor(v,scale,data.meta.floor_uses[i])));
});
it('equipment, lobby and garden outliers cannot shift office quantiles',()=>{
 const data=mockReplay('normal');data.meta.floor_uses[1]='equipment';data.meta.floor_uses[38]='equipment';
 const expected=dailyFloorScale(data);const changed=structuredClone(data);
 changed.hours.forEach(h=>h.floors_kw=h.floors_kw.map((v,i)=>changed.meta.floor_uses[i]==='office'?v:1e8));
 expect(dailyFloorScale(changed)).toEqual(expected);
 const noOffices=structuredClone(data);noOffices.meta.floor_uses.fill('equipment');
 expect(dailyFloorScale(noOffices)).toEqual({p10:0,p50:0,p90:0});
 expect(floorColor(9999,expected,'equipment')).toBe(EQUIPMENT_COLOR);
 expect(floorColor(0,expected,'equipment')).toBe(EQUIPMENT_COLOR);
 expect(floorColor(expected.p50,expected,'office')).toBe(FLOOR_COLORS[1]);
});
for(const scenario of ['normal','peak','abstain'])it(`real ${scenario} office scale ignores 2F/39F plant loads`,()=>{
 const data:ReplayData=JSON.parse(readFileSync(`public/replay/${scenario}.json`,'utf8'));
 expect(data.meta.floor_uses[1]).toBe('equipment');expect(data.meta.floor_uses[38]).toBe('equipment');
 const samples=data.hours.slice(8,21).flatMap(h=>h.floors_kw.filter((_,i)=>data.meta.floor_uses[i]==='office'));
 const scale=dailyFloorScale(data);expect(scale).toEqual(floorScale(samples));
 expect(scale).not.toEqual(floorScale(data.hours.flatMap(h=>h.floors_kw)));
 for(const index of [1,38])expect(floorColor(data.hours[14].floors_kw[index],scale,data.meta.floor_uses[index])).toBe(EQUIPMENT_COLOR);
});
it('daytime window is fixed, excludes 07/21 and includes 08/20',()=>{
 const data=mockReplay('normal'),scale=dailyFloorScale(data),changed=structuredClone(data);
 changed.hours.forEach((h,index)=>{if(index<8||index>20)h.floors_kw.fill(1e9);});
 expect(dailyFloorScale(changed)).toEqual(scale);
 for(const index of [8,20]){const boundary=structuredClone(data);boundary.hours[index].floors_kw.fill(1e9);expect(dailyFloorScale(boundary)).not.toEqual(scale);}
});
it('workday 14:00 office loads span three bands and 03:00 offices are mostly below p10',()=>{
 const data:ReplayData=JSON.parse(readFileSync('public/replay/normal.json','utf8')),scale=dailyFloorScale(data);
 // a47c3e3 proportional allocation export: refreshed anchors, unchanged three-band semantics.
 expect(Number(scale.p10.toFixed(1))).toBe(21.0);expect(Number(scale.p50.toFixed(1))).toBe(27.5);expect(Number(scale.p90.toFixed(1))).toBe(34.6);
 const offices=(hour:number)=>data.hours[hour].floors_kw.filter((_,i)=>data.meta.floor_uses[i]==='office');
 const daytime=offices(14);expect(daytime.filter(v=>v<scale.p50).length).toBeGreaterThan(0);expect(daytime.filter(v=>v>=scale.p50&&v<=scale.p90).length).toBeGreaterThan(0);expect(daytime.filter(v=>v>scale.p90).length).toBeGreaterThan(0);
 const night=offices(3);expect(night.filter(v=>v<scale.p10).length/night.length).toBeGreaterThan(.5);
});
it('handles missing and constant samples without division by zero',()=>{
 expect(floorColor(5,floorScale([5,5]))).toBe(FLOOR_COLORS[1]);expect(floorScale([NaN,1,3])).toEqual({p10:1.2,p50:2,p90:2.8});
});
