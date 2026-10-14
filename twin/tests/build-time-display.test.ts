import {it,expect} from 'vitest';
import {formatLocalMinute} from '../src/config/displayTime';
it('ISO build timestamp becomes browser-local date/minute; absent injection keeps fallback',()=>{
 const stamp='2026-10-12T05:04:22.545Z';const date=new Date(stamp);const pad=(n:number)=>String(n).padStart(2,'0');expect(formatLocalMinute(stamp)).toBe(`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`);expect(formatLocalMinute(stamp)).not.toMatch(/T|Z|\.545|:22/);expect(formatLocalMinute('源码包')).toBe('源码包');
});
