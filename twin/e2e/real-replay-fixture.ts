import type {Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
/** Isolate rendering regressions from concurrent schema-label/export edits. Numbers stay untouched. */
export async function realReplayFixture(page:Page,scenario='normal'){
 const data=JSON.parse(readFileSync(`public/replay/${scenario}.json`,'utf8'));
 const schema=JSON.parse(readFileSync('src/data/contracts/replay.schema.json','utf8'));
 const original=data.energy_summary?.label;
 if(data.energy_summary)data.energy_summary.label=schema.properties.energy_summary.properties.label.const;
 await page.route(`**/replay/${scenario}.json`,r=>r.fulfill({json:data}));
 return {data,labelAdjusted:original!==data.energy_summary?.label};
}
