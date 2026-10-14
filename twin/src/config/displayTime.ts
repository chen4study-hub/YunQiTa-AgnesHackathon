/** Local calendar display shared by all pages. Reference must be the bottom-bar display time. */
export type DisplayTime = Date | number | string;
const dateOf=(value:DisplayTime)=>value instanceof Date?value:new Date(value);
const pad=(n:number)=>String(n).padStart(2,'0');
export function localCalendarDate(value:DisplayTime):string {
 const d=dateOf(value);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
/** Calendar-day ordinal avoids DST and month/year boundary errors. */
const calendarDay=(d:Date)=>Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86_400_000;
export function formatRelativeTime(target:DisplayTime,displayAt:DisplayTime):string {
 const d=dateOf(target),reference=dateOf(displayAt);if(!Number.isFinite(d.getTime())||!Number.isFinite(reference.getTime()))return '—';
 const difference=calendarDay(d)-calendarDay(reference),clock=`${pad(d.getHours())}:${pad(d.getMinutes())}`;
 return `${difference===0?'':difference===1?'次日 ':difference===-1?'昨日 ':`${localCalendarDate(d)} `}${clock}`;
}
/** ISO build metadata uses UTC on disk, browser-local minute precision on screen. */
export function formatLocalMinute(value:DisplayTime):string {
 const date=dateOf(value);if(!Number.isFinite(date.getTime()))return typeof value==='string'?value:'—';
 return `${localCalendarDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Absolute hour offsets in a fixed window stay on their source calendar, even after midnight. */
export function hourOnDisplayDay(base:DisplayTime,hour:number):number {
 const d=new Date(dateOf(base));const dayOffset=Math.floor(hour/24),localHour=hour-dayOffset*24;
 d.setHours(0,0,0,0);d.setDate(d.getDate()+dayOffset);d.setHours(Math.floor(localHour),Math.round((localHour%1)*60),0,0);return d.getTime();
}
