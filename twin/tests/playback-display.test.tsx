import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {OverviewVerdict} from '../src/components/OverviewVerdict';
import {mockReplay} from '../src/data/adapters';
import {forecastView} from '../src/pages/forecast/data';
import {Timeline} from '../src/components/Timeline';
it('overview generated work-order IDs use next-day playback date rather than fixed URL date',()=>{
 const hour=mockReplay('abstain').hours[22];hour.agent.status='handoff';delete hour.agent.work_orders;
 const html=renderToStaticMarkup(<OverviewVerdict scenario="abstain" hour={hour} time={22} nowMs={new Date(2026,9,13,22).getTime()}/>);
 expect(html).toContain('#2026-1013-23');
});
it('forecast windows continue to use the reused zero-hour and six-hour contracts after wrap',()=>{
 const data=mockReplay('normal');for(const index of [22,0,6]){const view=forecastView(data,index);expect(view.current_t).toBe(data.hours[index].t);expect(view.forecast_24h).toHaveLength(24);expect(view.forecast_24h[0]).toMatchObject(data.hours[index].forecast_24h![0]);expect(view.forecast_24h[0].realized_abstain).toBe(data.hours[(index+1)%24].abstain);}
});
it('timeline rebases all cells to displayed date and marks midnight once',()=>{
 const html=renderToStaticMarkup(<Timeline time={0} playing={true} playbackStartMs={new Date(2026,9,12,22).getTime()} playbackElapsedHours={2} data={mockReplay('normal')} onChange={()=>{}}/>);
 expect(html).toContain('10-13');expect(html).toContain('data-day-offset="1"');expect(html.match(/timeline-date-label/g)).toHaveLength(1);expect(html).toContain('title="00:00"');expect(html).not.toMatch(/次日|data-playback-day/);
});
