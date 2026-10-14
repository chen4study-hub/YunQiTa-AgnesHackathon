import {expect,it} from 'vitest';
import {overviewForecastOption} from '../src/components/ReplayChart';
import {mockReplay} from '../src/data/adapters';
import {formatNumber,roundDisplay} from '../src/ui/numberFormat';
it('shared formatter groups numbers, limits decimals and handles nonfinite/negative zero',()=>{
 expect(formatNumber(1234.56789)).toBe('1,234.6');expect(formatNumber(42.651)).toBe('42.7');expect(formatNumber(-0.001)).toBe('0.0');expect(formatNumber(Infinity)).toBe('—');expect(formatNumber(1.234567,6)).toBe('1.23');expect(roundDisplay(37.400000000000006)).toBe(37.4);
});
it('all plotted values are rounded; tooltip uses actual bounds instead of stacked difference',()=>{
 const data=mockReplay('normal');const point=data.hours[14].forecast_24h[0];Object.assign(point,{lower_kw:1200.1234,upper_kw:1237.5234,point_kw:1218.8234,abstain:true});data.hours[15].abstain=true;const before=structuredClone(data);const option=overviewForecastOption(data,14);
 const series=option.series as any[];expect(series.map(s=>s.name)).toEqual(['预测下限','预测上限','预测','拒绝预测','实测']);expect((option.legend as any).data).toEqual(['实测','预测']);
 for(const s of series)for(const value of s.data){const number=Array.isArray(value)?value[1]:value;if(number!==null)expect(Math.abs(number*10-Math.round(number*10))).toBeLessThan(1e-8);}
 const tooltip=(option.tooltip as any).formatter([{axisValue:'15',name:'15'}]);expect(tooltip).toContain('预测下限：1,200.1 kW');expect(tooltip).toContain('预测上限：1,237.5 kW');expect(tooltip).toContain('拒绝预测');expect(tooltip).not.toContain('37.4');expect(tooltip).not.toMatch(/\d\.\d{3,}/);expect(data).toEqual(before);
});
