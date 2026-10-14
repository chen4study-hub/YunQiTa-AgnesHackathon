import {hourOnDisplayDay} from '../config/displayTime';
/** Cell starts at/before reference are measured. Playback reference is its head, not T0. */
export function timelineEvidence(hour:number,displayMs:number,realMs:number,playback=false) {
 const reference=playback?displayMs:realMs;
 const measured=hourOnDisplayDay(displayMs,hour)<=reference?1:0;
 return {measured,kind:measured?'measured':'forecast',nextDay:false};
}
