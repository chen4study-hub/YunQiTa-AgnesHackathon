import {it,expect} from 'vitest';
import {formatRelativeTime,hourOnDisplayDay} from '../src/config/displayTime';
const date=(v:string)=>new Date(v);
it('same day, next day, previous day, calendar months and years use the displayed local date',()=>{
 expect(formatRelativeTime(date('2026-10-12T14:23'),date('2026-10-12T23:00'))).toBe('14:23');
 expect(formatRelativeTime(date('2026-10-13T02:12'),date('2026-10-12T22:30'))).toBe('次日 02:12');
 expect(formatRelativeTime(date('2026-10-12T22:30'),date('2026-10-13T02:12'))).toBe('昨日 22:30');
 expect(formatRelativeTime(date('2026-11-01T00:00'),date('2026-10-31T23:00'))).toBe('次日 00:00');
 expect(formatRelativeTime(date('2026-12-31T23:00'),date('2027-01-01T00:00'))).toBe('昨日 23:00');
 expect(formatRelativeTime(date('2027-01-01T00:00'),date('2026-12-31T23:00'))).toBe('次日 00:00');
 expect(formatRelativeTime(date('2026-10-14T00:00'),date('2026-10-12T23:00'))).toBe('2026-10-14 00:00');
});
it('fixed window labels rebase after playback midnight while slot dates do not move',()=>{
 const start=date('2026-10-12T22:30'),head=date('2026-10-13T02:12');
 expect(formatRelativeTime(hourOnDisplayDay(start,22),head)).toBe('昨日 22:00');expect(formatRelativeTime(hourOnDisplayDay(start,26),head)).toBe('02:00');expect(formatRelativeTime(hourOnDisplayDay(head,2),head)).toBe('02:00');
});
