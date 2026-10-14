import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const out=join(process.env.TEMP!,'agh-tower-render-quality');
for(const dpr of [1,1.25,2])test(`tower render resolution and screenshot DPR ${dpr}`,async({browser})=>{
 const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:dpr,reducedMotion:'reduce'});const page=await context.newPage();await page.route('**/api/**',r=>r.abort());
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');await expect(page.locator('.twin-scene')).toHaveAttribute('data-render-active','true');
 await page.getByRole('button',{name:'真实外观',exact:true}).click();await expect.poll(async()=>JSON.parse((await page.locator('.twin-scene').getAttribute('data-scene'))||'{}').mode).toBe('real');await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1500);
 const phase=process.env.TOWER_CAPTURE_PHASE??'after';mkdirSync(out,{recursive:true});
 const rect=await page.locator('.twin-scene canvas').boundingBox();const bounds=JSON.parse((await page.locator('.scene-labels').getAttribute('data-tower-bounds'))!);
 const x=Math.max(0,Math.floor(rect!.x+bounds.x-6)),y=Math.max(0,Math.floor(rect!.y+bounds.y-6));const right=Math.min(1920,Math.ceil(rect!.x+bounds.x+bounds.width+6)),bottom=Math.min(1080,Math.ceil(rect!.y+bounds.y+bounds.height+6));
 await page.screenshot({path:join(out,`${phase}-dpr-${dpr}.png`),clip:{x,y,width:right-x,height:bottom-y},scale:'device'});
 const snap=JSON.parse((await page.locator('.twin-scene').getAttribute('data-scene'))!);writeFileSync(join(out,`${phase}-dpr-${dpr}.json`),JSON.stringify({dpr,bounds,rect,snap},null,2));
 if(phase!=='before'){
  expect(snap.renderQuality.pixelRatio).toBe(dpr);expect(snap.renderQuality.targetSamples).toEqual([4,4]);expect(snap.renderQuality.targetSize.map(Math.floor)).toEqual(snap.renderQuality.canvasSize);
  await page.getByRole('button',{name:'低画质',exact:true}).click();
  await expect.poll(async()=>{const state=JSON.parse((await page.locator('.twin-scene').getAttribute('data-scene'))!);return state.renderQuality.pixelRatio;}).toBe(1);
 }
 expect(errors).toEqual([]);await context.close();
});
test('resolution notifications update both targets repeatedly without CSS size changes',async({page,context})=>{
 // CDP changes DPR but does not reliably deliver native media change notifications.
 await page.addInitScript(()=>{const original=window.matchMedia.bind(window);const queries:MediaQueryList[]=[];(window as any).__resolutionQueries=queries;window.matchMedia=(text)=>{const q=original(text);if(text.includes('resolution:'))queries.push(q);return q;};});
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');
 await expect(page.locator('.twin-scene')).toHaveAttribute('data-render-active','true');const client=await context.newCDPSession(page);
 for(const dpr of [1.25,2,1]){
  await client.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:dpr,mobile:false});
  // Explicit notification exercises the real listener/re-arm; this is not a native zoom assertion.
  await page.evaluate(()=>{const q=(window as any).__resolutionQueries.at(-1) as MediaQueryList;q.dispatchEvent(new MediaQueryListEvent('change',{matches:q.matches,media:q.media}));});
  await expect.poll(async()=>{const state=JSON.parse((await page.locator('.twin-scene').getAttribute('data-scene'))!);return state.renderQuality?.pixelRatio;}).toBe(dpr);
  const state=JSON.parse((await page.locator('.twin-scene').getAttribute('data-scene'))!);expect(state.renderQuality.targetSize.map(Math.floor)).toEqual(state.renderQuality.canvasSize);
 }
 await client.detach();
});
