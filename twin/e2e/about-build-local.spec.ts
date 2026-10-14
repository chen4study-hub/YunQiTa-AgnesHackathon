import {test,expect} from '@playwright/test';
test.use({timezoneId:'Asia/Shanghai'});
test('about build time is local minute precision, not raw UTC ISO',async({page})=>{
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T14:00');await page.getByRole('button',{name:'关于',exact:false}).click();const text=await page.locator('.about-build-time').innerText();expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);expect(text).not.toMatch(/T|Z|\.\d{3}/);
 const sample=await page.evaluate(async()=>{const module=await import('/src/config/displayTime.ts' as string);return module.formatLocalMinute('2026-10-12T05:04:22.545Z');});expect(sample).toBe('2026-10-12 13:04');
});
