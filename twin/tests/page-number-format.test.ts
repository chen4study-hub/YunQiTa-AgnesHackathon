import { expect, it } from 'vitest';
import { floorsNumber } from '../src/pages/floors/numbers';
import { energyNumber } from '../src/pages/energy/data';
for(const format of [floorsNumber,energyNumber]) it(`${format.name}: groups large numbers, rounds floats, caps decimals and handles missing values`,()=>{
 expect(format(1234567.891,1)).toBe('1,234,567.9');
 expect(format(1234567.891)).toBe('1,234,568');
 expect(format(.30000000000004,9)).toBe('0.3');
 expect(format(-1234.56,1)).toBe('-1,234.6');
 expect(format(NaN)).toBe('—');expect(format(Infinity)).toBe('—');
});
