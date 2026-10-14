import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {serveDataOverrides} from './data-overrides-fixture';
const longDecimal=/(?<![\d.])[-+]?\d[\d,]*\.\d{3,}(?![\d.])/g;
const metricText=(text:string)=>text.replace(/\bv?\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/g,'[version]').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,'[build-time]');
for(const scope of ['overview-about','all-pages'])test(`number precision ${scope}: visible metrics and tooltips never have 3+ decimals`,async({page},info)=>{
 test.setTimeout(60000);await page.route('**/api/**',r=>r.abort());
 const card=JSON.parse(readFileSync('public/replay/model_card.json','utf8'));card.retained_mae=42.651;await serveDataOverrides(page, {'model_card.json': Buffer.from(JSON.stringify(card))});
 await page.addInitScript(()=>{const texts:string[]=[];(window as any).__drawnNumbers=texts;const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){texts.push(String(text));return original.call(this,text,...args);};});
 await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');await expect(page.locator('.overview-number')).toHaveCount(3);
 await expect(page.locator('.replay-chart .echart')).toHaveAttribute('_echarts_instance_',/./);
 const tooltip=await page.locator('.replay-chart .echart').evaluate(async el=>{
  const url=performance.getEntriesByType('resource').map(e=>e.name).find(name=>name.includes('/deps/echarts.js?'))!;
  const echarts=await import(url);const chart=echarts.getInstanceByDom(el);const option=chart.getOption();const formatter=option.tooltip[0].formatter;
  const text=formatter([{axisValue:'15',name:'15'}]);chart.dispatchAction({type:'showTip',seriesIndex:2,dataIndex:2});return {text,names:option.series.map((s:any)=>s.name),legend:option.legend[0].data};
 });
 expect(tooltip.names).toEqual(['预测下限','预测上限','预测','拒绝预测','实测']);expect(tooltip.legend).toEqual(['实测','预测']);expect(tooltip.text).toContain('预测下限：');expect(tooltip.text).toContain('预测上限：');expect(tooltip.text.match(longDecimal)).toBeNull();
 await expect.poll(()=>page.evaluate(()=>(window as any).__drawnNumbers.some((s:string)=>s.includes('预测上限：')))).toBe(true);
 const rendered=await page.evaluate(()=>(window as any).__drawnNumbers as string[]);expect(rendered.flatMap(s=>metricText(s).match(longDecimal)??[])).toEqual([]);
 const violations:{page:string;values:string[]}[]=[];
 for(const name of scope==='overview-about'?['总览','关于']:['总览','预测与风险','Agent 决策','楼层与电梯','能源与告警','关于']){
  await page.getByRole('button',{name,exact:false}).click();await page.waitForTimeout(150);const text=metricText(await page.locator('body').innerText());const values=text.match(longDecimal)??[];if(values.length)violations.push({page:name,values});
  if(name==='关于')await expect(page.locator('.about-metrics')).toContainText('42.7 kW');
  await page.locator('.echart,.energy-chart,.floors-load-chart').evaluateAll(async elements=>{
    const url=performance.getEntriesByType('resource').map(e=>e.name).find(name=>name.includes('/deps/echarts.js?'))!;const echarts=await import(url);
    for(const el of elements){if(!el.getBoundingClientRect().width)continue;const chart=echarts.getInstanceByDom(el);if(!chart)continue;const series=chart.getOption().series??[];for(let index=0;index<series.length;index++){if(series[index].data?.length>0){chart.dispatchAction({type:'showTip',seriesIndex:index,dataIndex:Math.min(2,series[index].data.length-1)});}}}
  });
  await page.waitForTimeout(60);
  const drawn=await page.evaluate(()=>(window as any).__drawnNumbers.splice(0) as string[]);const tooltipValues=drawn.flatMap(s=>metricText(s).match(longDecimal)??[]);if(tooltipValues.length)violations.push({page:`${name} tooltip/canvas`,values:tooltipValues});
 }
 await info.attach('precision-audit.json',{body:JSON.stringify({tooltip,violations}),contentType:'application/json'});expect(violations).toEqual([]);
});
