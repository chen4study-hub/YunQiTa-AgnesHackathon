import {test,expect} from '@playwright/test';
import {join} from 'node:path';
test.use({viewport:{width:1366,height:768},reducedMotion:'no-preference'});
test('batched tower stays below 100 draws without changing MSAA, DPR, shadows, detail or interactions',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T14:00');const host=page.locator('.twin-scene');await expect(host).toHaveAttribute('data-scene',/drawCalls/);await page.waitForTimeout(1500);
 const state=()=>host.evaluate(el=>JSON.parse((el as HTMLElement).dataset.scene!));
 const normal=await state();console.log('SCENE_BATCH',JSON.stringify({calls:normal.drawCalls,triangles:normal.triangles,cost:normal.frameCost}));expect(normal.drawCalls).toBeLessThanOrEqual(100);expect(normal.renderQuality.targetSamples).toEqual([4,4]);expect(normal.renderQuality.pixelRatio).toBe(1);expect(normal.renderQuality.shadows).toBe(true);expect(normal.renderQuality.shadowMapSize).toEqual([2048,2048]);
 await page.getByRole('button',{name:'自动旋转',exact:true}).click();await page.screenshot({path:join(process.env.TEMP!,'agh-batched-tower.png')});
 const point=normal.floorPoint;await host.click({position:point});await expect.poll(async()=>(await state()).selected).not.toBeNull();
 await page.getByRole('button',{name:'透视',exact:true}).click();await page.getByRole('button',{name:'展开楼层',exact:true}).click();await page.waitForTimeout(1200);const expanded=await state();expect(expanded.drawCalls).toBeLessThanOrEqual(100);expect(expanded.spacing).toBeGreaterThan(2.3);expect(expanded.xray).toBe(true);expect(expanded.glassOpacity).toBeCloseTo(.12,2);await info.attach('scene-batching.json',{body:JSON.stringify({normal,expanded,errors}),contentType:'application/json'});expect(errors.filter(e=>/shader|WebGL|THREE|TypeError/.test(e))).toEqual([]);
});
