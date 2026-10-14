import { DESKTOP_125 } from "./viewport-profile";
import {expect,test} from '@playwright/test';
for(const size of [{width:1366,height:768},{width:1600,height:830},DESKTOP_125,{width:1920,height:1080},{width:390,height:844}]) test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`EMS total labels separated from numeric line boxes ${size.width}`, async({page})=>{
 await page.setViewportSize(size);await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');
 await expect(page.locator('.bottombar')).toBeVisible();await page.getByRole('button',{name:'能源与告警'}).click();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);
 const cells=page.locator('.energy-ems-totals > div');const gaps=[];
 for(let i=0;i<3;i++){const cell=cells.nth(i),label=await cell.locator(':scope > span').boundingBox();for(const selector of ['b','b > .energy-number','b > small']){const value=await cell.locator(selector).boundingBox();const gap=value!.y-(label!.y+label!.height);gaps.push({selector,gap});expect(gap).toBeGreaterThanOrEqual(3.9);}}
 console.log(size.width,JSON.stringify(gaps));
});
  });
