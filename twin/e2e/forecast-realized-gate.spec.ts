import {test,expect} from '@playwright/test';
test('rolling chart rejection regions follow target-hour gates across different origins',async({page})=>{
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&scenario=normal&at=2026-10-12T23:00');
 const host=page.locator('.replay-chart .echart');await expect(host).toHaveAttribute('_echarts_instance_',/./);
 const initial=await host.evaluate(async el=>{const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/deps/echarts.js?'))!;const echarts=await import(url);const option=echarts.getInstanceByDom(el).getOption();return {axis:option.xAxis[0].data,red:option.series[3].data.map((p:any)=>Number(p[0])%24)};});
 expect(initial.axis[2]).toBe('24');
 const gates=await page.locator('.timeline-cell').evaluateAll(cells=>cells.filter(c=>c.classList.contains('reject')).map(c=>Number((c as HTMLElement).dataset.hour)));
 expect([...initial.red].sort((a,b)=>a-b)).toEqual(gates);
 await page.locator('.timeline').press('Home');await expect(page.locator('.replay-chart')).toHaveAttribute('data-time','0');
 await expect.poll(()=>host.evaluate(async el=>{const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/deps/echarts.js?'))!;const e=await import(url);return e.getInstanceByDom(el).getOption().xAxis[0].data[0];})).toBe('-1');
 const red=await host.evaluate(async el=>{const url=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('/deps/echarts.js?'))!;const e=await import(url);return e.getInstanceByDom(el).getOption().series[3].data.map((p:any)=>Number(p[0])%24).sort((a:number,b:number)=>a-b);});expect(red).toEqual(gates);
});
