import {test,expect} from '@playwright/test';
test.use({timezoneId:'Asia/Shanghai'});
test('opening 11:25 selects 11; RAF box and cursor share a frame; t+24h wraps and resets',async({page})=>{
 test.setTimeout(90000);
 page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));await page.clock.install({time:new Date('2026-10-12T11:25:00+08:00')});await page.clock.pauseAt(new Date('2026-10-12T11:25:00+08:00'));await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T11:25');await expect(page.locator('.overview-number')).toHaveCount(3);
 await expect(page.locator('.timeline-cell.current')).toHaveAttribute('data-hour','11');await expect(page.getByLabel('当前本地时间')).toHaveText('2026-10-12 周一 11:25:00');await page.getByRole('button',{name:'▶ 播放',exact:true}).click();
 await page.clock.runFor(800);const position=await page.locator('.timeline').evaluate(root=>{const box=root.querySelector('.timeline-slider')!,cursor=box.querySelector('.timeline-cursor')!,selected=root.querySelector('.timeline-cell.current')!,b=box.getBoundingClientRect(),c=cursor.getBoundingClientRect(),s=selected.getBoundingClientRect();return {time:Number((root as HTMLElement).dataset.time),boxX:b.left,selectedX:s.left,cursorX:c.left,width:b.width,transition:getComputedStyle(box).transitionDuration};});
 expect(position.transition).toBe('0s');expect(Math.abs(position.boxX-position.selectedX)).toBeLessThan(1);expect(Math.abs(position.cursorX-position.boxX-(position.time%1)*position.width)).toBeLessThan(1);
 await page.clock.runFor(12200);await expect(page.getByLabel('当前本地日期')).toHaveText('2026-10-13 周二');await expect(page.locator('.timeline-cell.current')).toHaveAttribute('data-hour','0');await expect(page.locator('.timeline')).toHaveAttribute('data-day-offset','1');
 await page.clock.runFor(11032);await expect(page.getByRole('button',{name:'↺ 重置',exact:true})).toBeVisible();await expect(page.getByLabel('当前本地时间')).toHaveText('2026-10-13 周二 11:25:00');await expect(page.locator('.timeline-cell.current')).toHaveAttribute('data-hour','11');
 await page.getByRole('button',{name:'↺ 重置',exact:true}).click();await expect(page.getByLabel('当前本地时间')).toHaveText('2026-10-12 周一 11:25:00');await expect(page.locator('.timeline-cell.current')).toHaveAttribute('data-hour','11');
});
