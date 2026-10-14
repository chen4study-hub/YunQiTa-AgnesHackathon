import {test,expect} from '@playwright/test';
test('overview y-axis uses nice integer ticks without raw data endpoint labels',async({page})=>{
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');const host=page.locator('.replay-chart .echart');await expect(host).toHaveAttribute('_echarts_instance_',/./);
 const result=await host.evaluate(async el=>{const text=await(await fetch('/src/components/EChart.tsx')).text();const e=await import(text.match(/from\s+["']([^"']*\/echarts\.js[^"']*)["']/)![1]);const chart=e.getInstanceByDom(el),option=chart.getOption(),y=option.yAxis[0];const axis=chart.getModel().getComponent('yAxis').axis;const ticks=axis.scale.getTicks().map((t:any)=>t.value);return {min:y.min,max:y.max,interval:y.interval,minLabel:y.axisLabel.showMinLabel,maxLabel:y.axisLabel.showMaxLabel,labels:ticks.map((v:number)=>y.axisLabel.formatter(v))};});
 expect(result.min%result.interval).toBe(0);expect(result.max%result.interval).toBe(0);expect(result.minLabel).toBe(false);expect(result.maxLabel).toBe(false);expect(result.labels.every((l:string)=>/^-?[\d,]+$/.test(l))).toBe(true);
});
