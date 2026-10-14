import {test,expect} from '@playwright/test';
import {realReplayFixture} from './real-replay-fixture';
test('continuous playhead fills only the rendered plot, never the legend or tick labels',async({page})=>{
 await realReplayFixture(page);await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T11:25');await page.getByRole('button',{name:'▶ 播放',exact:true}).click();await page.waitForTimeout(1800);
 const geometry=await page.locator('.replay-chart .echart').evaluate(async el=>{const text=await(await fetch('/src/components/EChart.tsx')).text();const e=await import(text.match(/from\s+["']([^"']*\/echarts\.js[^"']*)["']/)![1]);const instance=e.getInstanceByDom(el);const rect=instance.getModel().getComponent('grid').coordinateSystem.getRect();const box=el.getBoundingClientRect(),line=el.parentElement!.querySelector('.forecast-playhead')!.getBoundingClientRect();return {plotTop:box.top+rect.y,plotBottom:box.top+rect.y+rect.height,lineTop:line.top,lineBottom:line.bottom,plotLeft:box.left+rect.x,plotRight:box.left+rect.x+rect.width,lineX:line.left};});
 console.log('PLAYHEAD_RECT',JSON.stringify(geometry));
 expect(Math.abs(geometry.lineTop-geometry.plotTop)).toBeLessThan(1);expect(Math.abs(geometry.lineBottom-geometry.plotBottom)).toBeLessThan(1);expect(geometry.lineX).toBeGreaterThan(geometry.plotLeft);expect(geometry.lineX).toBeLessThan(geometry.plotRight);
});
