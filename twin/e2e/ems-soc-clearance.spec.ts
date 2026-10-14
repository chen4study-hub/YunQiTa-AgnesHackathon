import { DESKTOP_125 } from "./viewport-profile";
import {expect,test} from '@playwright/test';
for(const size of [{width:1366,height:768},{width:1600,height:830},DESKTOP_125,{width:1920,height:1080},{width:390,height:844}]) test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`SOC text clears stroked arc endpoints ${size.width}`, async({page})=>{
 await page.setViewportSize(size);await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');
 await expect(page.locator('.bottombar')).toBeVisible();await page.getByRole('button',{name:'能源与告警'}).click();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);
 const endpoints=await page.locator('.energy-soc-base').evaluate(el=>{
  const path=el as SVGPathElement,m=path.getScreenCTM()!,r=parseFloat(getComputedStyle(path).strokeWidth)/2;
  return [0,path.getTotalLength()].map(length=>{const p=path.getPointAtLength(length),corners=[[-r,-r],[-r,r],[r,-r],[r,r]].map(([x,y])=>new DOMPoint(p.x+x,p.y+y).matrixTransform(m));const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y);return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};});
 });
 const label=await page.locator('.energy-soc-reading > span').boundingBox();expect(label).not.toBeNull();
 const intersections=endpoints.map(e=>({x:Math.min(label!.x+label!.width,e.x+e.width)-Math.max(label!.x,e.x),y:Math.min(label!.y+label!.height,e.y+e.height)-Math.max(label!.y,e.y)}));
 console.log(size.width,JSON.stringify({label,endpoints,intersections}));for(const i of intersections)expect(i.x<=0||i.y<=0).toBe(true);
});
  });
