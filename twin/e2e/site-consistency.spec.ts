import {test,expect,type Page} from '@playwright/test';
import {setTimelineHour} from './timeline-helper';
import {readFileSync} from 'node:fs';
import {replayWithAgentDetails} from './replay-agent-fixture';
import {freezeTestHmr} from './shell-scroll-policy';
test.beforeEach(async ({page})=>{await freezeTestHmr(page);await page.route('**/api/**',r=>r.abort());});
const num=(value:number)=>value.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const clean=(text:string)=>text.replace(/\s+/g,' ').trim();

// Keep expectations independent of the formatter, so a wrong public calendar cannot self-pass.
const displayDates = [
 ['normal','工作日','2026-10-12 周一'],
 ['peak','高温日','2026-07-23 周四'],
 ['abstain','节假日','2026-10-01 周四 国庆节'],
] as const;
// Separate DOM unit spans use a measured 3–4px CSS gap, not a literal text space.
async function pairText(locator: import('@playwright/test').Locator){
 const pair=await locator.evaluate(el=>{
  const unit=el.querySelector('small')!,number=el.querySelector('.smooth-value,.energy-number')!;
  const n=number.getBoundingClientRect(),u=unit.getBoundingClientRect();
  return {number:number.textContent!.trim(),unit:unit.textContent!.trim(),gap:u.left-n.right,align:getComputedStyle(el).alignItems};
 });
 expect(pair.align).toBe('baseline');
 if(pair.unit==='%')expect(pair.gap).toBe(0);
 else {expect(pair.gap).toBeGreaterThanOrEqual(3);expect(pair.gap).toBeLessThanOrEqual(4);}
 return `${pair.number}${pair.unit==='%'?'':' '}${pair.unit}`;
}
const datePages=['总览','预测与风险','Agent 决策','楼层与电梯','能源与告警','关于'];
async function businessDateText(page:Page){
 return page.locator('.dashboard').evaluate(root=>{
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts:string[]=[];
  let node:Node|null;
  while((node=walker.nextNode())){
   const parent=node.parentElement;
   // Only this actual build-time field is exempt. The rest of About stays audited.
   if(!parent||parent.closest('.about-page .about-build-time')||!parent.checkVisibility({checkVisibilityCSS:true}))continue;
   const range=document.createRange();range.selectNodeContents(node);
   if(range.getClientRects().length&&node.textContent?.trim())parts.push(node.textContent);
  }
  return parts.join('\n');
 });
}
test('date audit excludes only the build-time field, not other About dates or source years',async({page})=>{
 await page.goto('/?source=file');await page.getByRole('navigation',{name:'页面导航'}).getByRole('button',{name:/关于/}).click();
 await expect(page.locator('.about-build-time')).toBeVisible();
 await page.locator('.about-build-time').evaluate(el=>{el.innerHTML='<span>2016-01-02T03:04:05Z</span>';});
 await page.locator('.about-page').evaluate(el=>{const p=document.createElement('p');p.textContent='原始日期 2017-03-04';el.append(p);});
 const text=await businessDateText(page);
 expect(text).not.toContain('2016-01-02');
 expect(text).toContain('2017-03-04');
 expect(text).toMatch(/(?<!\d)20(?:0\d|1\d)(?!\d)/);
});
test('holiday overview handoff uses the same display calendar as the footer',async({page})=>{
 await page.goto('/?source=file&at=2026-10-01T14:00');await setTimelineHour(page,14);
 await expect(page.locator('.timeline')).toHaveAttribute('data-time','14');
 await expect(page.locator('.bottombar .clock')).toContainText('2026-10-01 周四 国庆节');
 await expect(page.locator('.agent-verdict')).toContainText('人工复核');
 await page.getByRole('button',{name:'Agent 决策'}).click();
 await page.getByRole('button',{name:'查看人工工单',exact:true}).click();
 const ticket=page.getByRole('dialog',{name:'人工工单',exact:true});
 await expect(ticket).toContainText('人工工单 · 暂无数据');
 await expect(ticket).toContainText('风险评分超过门控阈值');
});
for(const [scenario,day,expected] of displayDates)test(`cross-page display dates ${day}`,async({page},info)=>{
 test.setTimeout(60000);await page.goto(`/?source=file&at=${expected.slice(0,10)}T14:00`);
 await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
 const violations:unknown[]=[],samples:unknown[]=[];
 for(const hour of [0,14,23])for(const name of datePages){
  await page.getByRole('navigation',{name:'页面导航'}).getByRole('button',{name,exact:false}).click();
  await setTimelineHour(page,hour);await expect(page.locator('.timeline')).toHaveAttribute('data-time',String(hour));await page.waitForTimeout(150);
  const clock=clean(await page.locator('.bottombar .clock').innerText());
  if(!clock.startsWith(`${expected} `))violations.push({scenario,hour,page:name,kind:'footer-date',display:clock,expected});
  const text=await businessDateText(page);
  const lines=text.split('\n').map(clean).filter(Boolean);
  // Full dates (ISO, slash, or Chinese) plus old source years even when embedded in IDs.
  const datePattern=/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?/g;
  const expectedISO=expected.slice(0,10);
  for(const line of lines){
   // About explicitly discloses original measured year; it is not a query date.
   // Exempt this exact factual sentence only, never arbitrary About source years.
   if(name==='关于'&&line==='来自 BDG2 Byron 楼 2017 年逐时实测，按日期类型对应到今天。')continue;
   for(const match of line.matchAll(datePattern)){
    const iso=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
    samples.push({scenario,hour,page:name,date:iso,line});
    if(iso!==expectedISO)violations.push({scenario,hour,page:name,kind:'visible-date',display:match[0],expected:expectedISO,line});
   }
   if(/(?<!\d)20(?:0\d|1\d)(?!\d)/.test(line))violations.push({scenario,hour,page:name,kind:'raw-source-year',line,expected});
   const weekday=line.match(/周[一二三四五六日天]/)?.[0];
   if(weekday&&weekday!==expected.match(/周./)![0])violations.push({scenario,hour,page:name,kind:'weekday',display:weekday,expected,line});
  }
 }
 await info.attach('date-samples.json',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
 await info.attach('date-violations.json',{body:JSON.stringify(violations,null,2),contentType:'application/json'});
 console.log('DATE_VIOLATIONS '+JSON.stringify(violations));
 expect(violations,'every visible date must match the scenario/footer calendar; no source years').toEqual([]);
});
for(const [scenario,day,expectedDate] of displayDates)test(`cross-page values and number-unit format ${day}`,async({page},info)=>{
 test.setTimeout(60000);await page.goto(`/?source=file&at=${expectedDate.slice(0,10)}T14:00`);await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
 const data=replayWithAgentDetails(scenario);
 const ops=JSON.parse(readFileSync(`public/replay/${scenario}.ops.json`,'utf8'));const violations:unknown[]=[];const samples:unknown[]=[];
 for(const hour of [0,14,23]){
  const h=data.hours[hour];const expected={pred:`${num(h.point_kw)} kW`,actual:`${num(h.actual_kw)} kW`,confidence:`${num(h.confidence*100)}%`,soc:`${num(h.storage.soc*100)}%`};
  const check=(where:string,key:keyof typeof expected,text:string)=>{const unit=key==='confidence'||key==='soc'?'%':'kW';const match=clean(text).match(new RegExp(`(-?\\d[\\d,]*(?:\\.\\d+)?)(\\s*)${unit}`));const display=match?.[0]??null;samples.push({scenario,hour,where,key,display,expected:expected[key]});if(display!==expected[key])violations.push({scenario,hour,where,key,display,expected:expected[key],kind:match&&Number(match[1].replaceAll(',',''))===Number(expected[key].match(/^-?[\d,.]+/)![0].replaceAll(',',''))?'format':'value',text:clean(text)});};
  await page.getByRole('button',{name:'总览',exact:false}).click();await setTimelineHour(page,hour);await expect(page.locator('.timeline')).toHaveAttribute('data-time',String(hour));await page.waitForTimeout(320);
  check('总览/指标','pred',await page.locator('.overview-number').first().textContent()??'');
  check('总览/当前实测','actual',await page.locator('.overview-actual .animated-number-text').textContent()??'');
  check('总览/模型状态','confidence',await page.locator('.model-status p .animated-number-text').textContent()??'');
  check('总览/塔楼标签','pred',await page.locator('[data-anchor="tower"] b').textContent()??'');
  check('总览/塔楼标签','confidence',await page.locator('[data-anchor="tower"]').textContent()??'');
  check('总览/储能标签','soc',(await page.locator('[data-anchor="storage"]').textContent()??'').split('SOC')[1]??'');
  await page.getByRole('button',{name:'预测与风险',exact:false}).click();await page.waitForTimeout(150);
  for(const [key,label] of [['pred','当前预计负荷'],['actual','原始观测'],['confidence','置信度']] as const){const el=page.locator('.forecast-metric').filter({has:page.locator('dt',{hasText:new RegExp(`^${label}$`)})});check(`预测与风险/${label}`,key,await pairText(el.locator('dd')));}
  await page.getByRole('button',{name:'能源与告警',exact:false}).click();await page.waitForTimeout(150);
  // Energy is sourced from the public ops contract, not the replay forecast channel.
  const opsHour=ops.hours[hour];
  const energyExpected={...expected,actual:`${num(opsHour.actual_kw)} kW`,soc:`${num(opsHour.storage.soc*100)}%`};
  for(const [key,selector] of [['actual','.energy-donut-total b'],['soc','.energy-soc b']] as const){
   const previous=expected[key];expected[key]=energyExpected[key];check(`能源与告警/${key}`,key,await pairText(page.locator(selector)));expected[key]=previous;
  }
  await page.getByRole('button',{name:'Agent 决策',exact:false}).click();await page.waitForTimeout(150);
  check('Agent/状态','confidence',await page.locator('.agent-status-bar > span').textContent()??'');
  const context=page.locator('.agent-steps li[title="get_context"]');await expect(context).toHaveCount(1);check('Agent/上下文','soc',(await context.textContent()??'').split('SOC')[1]??'');
 }
 await info.attach('consistency-samples.json',{body:JSON.stringify(samples,null,2),contentType:'application/json'});await info.attach('consistency-violations.json',{body:JSON.stringify(violations,null,2),contentType:'application/json'});console.log('CONSISTENCY_VIOLATIONS '+JSON.stringify(violations));expect.soft(violations.filter(v=>(v as {kind:string}).kind==='value'),'canonical numerical values').toEqual([]);expect(violations,'thousands grouping, percent attached, other units separated by one space').toEqual([]);
});
