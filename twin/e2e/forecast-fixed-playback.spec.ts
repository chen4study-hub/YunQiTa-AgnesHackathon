import {test,expect} from '@playwright/test';
import {realReplayFixture} from './real-replay-fixture';
import {currentUI4183} from './agent-local-ui-4183';
test.use({timezoneId:'Asia/Shanghai'});
test('fixed 24h axis keeps every red slot invariant and turns played predictions into actuals',async({page})=>{
 test.setTimeout(120000);await currentUI4183(page);await realReplayFixture(page);await page.clock.install({time:new Date('2026-10-12T23:00:00+08:00')});await page.clock.pauseAt(new Date('2026-10-12T23:00:00+08:00'));await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&scenario=normal&at=2026-10-12T23:00');
 await expect(page.locator('.overview-number')).toHaveCount(3);await page.clock.runFor(64);
 const host=page.locator('.replay-chart .echart');await expect(host).toHaveAttribute('_echarts_instance_',/./);
 const read=()=>host.evaluate(async el=>{const source=await (await fetch('/src/components/EChart.tsx')).text();const url=source.match(/from\s+["']([^"']*\/echarts\.js[^"']*)["']/)![1];const e=await import(url);const option=e.getInstanceByDom(el).getOption();return {axis:option.xAxis[0].data,red:option.series[2].markArea.data.map((pair:any[])=>pair.map(p=>p.xAxis)),actual:option.series[4].data,forecast:option.series[2].data,lower:option.series[0].data,y:{min:option.yAxis[0].min,max:option.yAxis[0].max,interval:option.yAxis[0].interval}};});
 await page.getByRole('button',{name:'▶ 播放',exact:true}).click();await page.clock.runFor(160);const first=await read();expect(first.axis).toEqual(Array.from({length:26},(_,i)=>String(22+i)));
 const facts=await page.evaluate(async()=>{const r=await fetch('/replay/normal.json');return (await r.json()).hours.map((h:any)=>Number(h.actual_kw.toFixed(1)));});
 const positions:number[]=[];
 for(let hour=1;hour<=24;hour++){
  await page.clock.runFor(968);await expect(page.locator('.replay-chart')).toHaveAttribute('data-actual-count',String(hour+2));await page.clock.runFor(32);
  const state=await read();expect(state.axis).toEqual(first.axis);expect(state.y).toEqual(first.y);expect(state.red).toEqual(first.red);for(let index=2;index<=hour+1;index++)expect(state.actual[index]).toBe(facts[(22+index)%24]);for(let index=hour+2;index<26;index++)expect(state.actual[index]).toBeNull();
  positions.push(await page.locator('.forecast-playhead').evaluate(el=>el.getBoundingClientRect().left));
  if(hour===2){const before=positions.at(-1)!;await page.clock.runFor(100);const after=await page.locator('.forecast-playhead').evaluate(el=>el.getBoundingClientRect().left);expect(after).toBeGreaterThan(before);}
 }
 expect(positions.every((x,i)=>i===0||x>positions[i-1])).toBe(true);const end=await read();expect(end.actual.every((x:any)=>x!==null)).toBe(true);expect(end.forecast.every((x:any)=>x===null)).toBe(true);expect(end.lower.every((x:any)=>x===null)).toBe(true);await expect(page.getByRole('button',{name:'↺ 重置',exact:true})).toBeVisible();
});
