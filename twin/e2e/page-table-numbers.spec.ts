import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from '@playwright/test';
import { freezeTestHmr } from './shell-scroll-policy';
test.beforeEach(async ({page}) => freezeTestHmr(page));
for(const width of [1366,DESKTOP_125.width,1920,390]) test.describe(`viewport ${width}`, () => {
    test.use({ deviceScaleFactor: width === DESKTOP_125.width ? DESKTOP_125.dpr : 1 });
    test(`two-page numeric text and table bounds ${width}`, async({page})=>{
 await page.setViewportSize({width,height:width===390?844:width===1366?768:width===DESKTOP_125.width?DESKTOP_125.height:1080});
 await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');
 await expect(page.locator('.bottombar')).toBeVisible();
 for(const [label,root,table] of [['楼层与电梯','.floors-page','.floors-lift-table'],['能源与告警','.energy-page','.energy-alert-table']]){
  await page.goto('/?source=file&scenario=normal&at=2026-10-12T14:00');
  await expect(page.locator('.bottombar')).toBeVisible();
  await page.getByRole('button',{name:label}).click();await expect(page.locator(root)).toBeVisible();await page.waitForTimeout(600);
  const texts=await page.locator(`${root} .floors-number, ${root} .energy-number, ${table} tbody td`).allTextContents();
  for(const s of texts){expect(s).not.toMatch(/\d+\.\d{2,}/);expect(s).not.toMatch(/(?<![\d:])\d{4,}(?![\d:])/);}
  const overflow=await page.locator(`${table} tbody td, ${table} tbody th`).evaluateAll(es=>es.flatMap(e=>{
   const er=e.getBoundingClientRect(); const nodes=e.querySelectorAll('b,small');const leaves=nodes.length?[...nodes]:[e];
   return leaves.flatMap(n=>{const range=document.createRange();range.selectNodeContents(n);const rs=[...range.getClientRects()];return rs.filter(r=>r.left<er.left-1||r.right>er.right+1).map(r=>({text:n.textContent,excess:Math.max(er.left-r.left,r.right-er.right)}));});
  }));console.log(width,label,JSON.stringify({overflow}));expect(overflow).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
});
  });
