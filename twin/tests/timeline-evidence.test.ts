import {expect,it} from 'vitest';
import {timelineEvidence} from '../src/components/timelineEvidence';
it('cell start at or before real time is measured; playback instead uses the displayed head',()=>{
 const real=new Date(2026,9,12,11,25).getTime();for(const hour of [10,11])expect(timelineEvidence(hour,real,real)).toMatchObject({kind:'measured',measured:1});expect(timelineEvidence(12,real,real)).toMatchObject({kind:'forecast',nextDay:false});
 const played=new Date(2026,9,12,18).getTime();expect(timelineEvidence(12,played,real).kind).toBe('forecast');expect(timelineEvidence(12,played,real,true).kind).toBe('measured');
});
it('22:30 to 02:12 playback: zero, one and two are same-display-day measured cells',()=>{
 const real=new Date(2026,9,12,22,30).getTime(),next=new Date(2026,9,13,2,12).getTime();for(let hour=0;hour<24;hour++)expect(timelineEvidence(hour,next,real,true)).toMatchObject({kind:hour<=2?'measured':'forecast',measured:hour<=2?1:0,nextDay:false});
});
