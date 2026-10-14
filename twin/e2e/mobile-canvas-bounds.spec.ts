import {test,expect} from '@playwright/test';
test.use({viewport:{width:390,height:844},deviceScaleFactor:3});
test('DPR3 mobile canvas cannot expand or escape the scene card',async({page})=>{
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T14:00');await expect(page.locator('.twin-scene')).toHaveAttribute('data-render-active','true');
 const read=()=>page.evaluate(()=>{const card=document.querySelector('.overview-scene')!.getBoundingClientRect(),canvas=document.querySelector('.twin-scene canvas')! as HTMLCanvasElement,box=canvas.getBoundingClientRect(),wrap=document.querySelector('.scene-wrapper')!.getBoundingClientRect();return {cardRight:card.right,canvasRight:box.right,canvasLeft:box.left,width:box.width,wrapperWidth:wrap.width,inlineWidth:canvas.style.width,overflow:document.documentElement.scrollWidth-innerWidth};});
 await expect.poll(async()=>{const r=await read();return r.canvasRight<=r.cardRight&&r.width===r.wrapperWidth&&r.width<390;}).toBe(true);const r=await read();expect(r.inlineWidth).toBe('');expect(r.overflow).toBeLessThanOrEqual(1);
 await page.getByRole('button',{name:'低画质',exact:true}).click();await page.getByRole('button',{name:'低画质',exact:true}).click();await expect.poll(async()=>{const r=await read();return r.canvasRight<=r.cardRight&&r.width<390;}).toBe(true);
});
