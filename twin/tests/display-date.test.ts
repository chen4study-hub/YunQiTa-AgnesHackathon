import {afterEach,expect,it,vi} from 'vitest';
import {formatDisplayDate,formatDisplayTimestamp} from '../src/config/presentation';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('formats real local date and HH:mm:ss, with no route labels',()=>{
 expect(formatDisplayDate(new Date(2026,9,12,14,23,5))).toBe('2026-10-12 周一');
 expect(formatDisplayTimestamp(new Date(2026,9,12,14,23,5))).toBe('2026-10-12 周一 14:23:05');
 expect(formatDisplayDate(new Date(2026,9,11))).toBe('2026-10-11 周日');
 expect(formatDisplayDate(new Date(2026,9,10))).toBe('2026-10-10 周六');
 expect(formatDisplayDate(new Date(2026,9,1))).toBe('2026-10-01 周四 国庆节');
 expect(formatDisplayDate(new Date(2026,5,19))).toBe('2026-06-19 周五 端午节');
});
it('legacy route arguments compile but always resolve today; hidden at is independent of scenario',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,14,23,5));
 for(const route of ['normal','peak','abstain'] as const)expect(formatDisplayDate(route)).toBe('2026-10-12 周一');
 vi.stubGlobal('location',{search:'?scenario=abstain&at=2026-07-23T14:00'});expect(formatDisplayDate()).toBe('2026-07-23 周四');
});
