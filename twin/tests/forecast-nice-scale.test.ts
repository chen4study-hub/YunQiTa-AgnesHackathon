import {it,expect} from 'vitest';
import {niceIntegerScale} from '../src/ui/chartScale';
import {overviewForecastOption} from '../src/components/ReplayChart';
import {mockReplay} from '../src/data/adapters';
it('nice integer scale pads data and labels never show decimal suffix or raw endpoints',()=>{
 for(const [lo,hi] of [[689,1389],[1200.7,1201.2],[0,0],[-60.5,7.9]]){const scale=niceIntegerScale(lo,hi);expect(scale.min).toBeLessThan(lo);expect(scale.max).toBeGreaterThan(hi);expect(Math.abs(scale.min%scale.interval)).toBe(0);expect(Math.abs(scale.max%scale.interval)).toBe(0);expect(Number.isInteger(scale.interval)).toBe(true);}
 const y=overviewForecastOption(mockReplay('normal'),14).yAxis as any;expect(y.axisLabel.formatter(1200)).toBe('1,200');expect(y.axisLabel.showMinLabel).toBe(false);expect(y.axisLabel.showMaxLabel).toBe(false);expect(y.min%y.interval).toBe(0);expect(y.max%y.interval).toBe(0);
});
