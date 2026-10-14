import {test,expect} from '@playwright/test';
import {realReplayFixture} from './real-replay-fixture';
test('overview and Agent source badges show only decision source, wording is hover-only',async({page})=>{
 await realReplayFixture(page);await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T14:00');const overview=page.locator('.overview-decision-source');await expect(overview).toHaveText(/^(LLM|规则) 决策$/);await expect(overview).toHaveAttribute('title',/措辞/);expect(await page.locator('.agent-verdict').innerText()).not.toMatch(/模板措辞|LLM 措辞/);
 await page.getByRole('button',{name:'Agent 决策',exact:false}).click();const agent=page.locator('.agent-decision-source');await expect(agent).toHaveText(/^(LLM|规则) 决策$/);await expect(agent).toHaveAttribute('title',/措辞/);expect(await page.locator('.agent-decision-card').innerText()).not.toMatch(/模板措辞|LLM 措辞/);
});
