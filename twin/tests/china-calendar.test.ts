import {afterEach, expect, it, vi} from 'vitest';
import {CHINA_HOLIDAYS_2026, CHINA_MAKEUP_WORKDAYS_2026, chinaDay, scenarioForDate, scenarioOverride} from '../src/config/chinaCalendar';
import {DashboardStore} from '../src/state/store';
import {MockAdapter, mockReplay} from '../src/data/adapters';
const date=(key:string)=>new Date(`${key}T14:00:00`);
afterEach(()=>vi.useRealTimers());
it('covers all 33 notified days off with the correct holiday names and 6 makeup workdays',()=>{
 expect(CHINA_HOLIDAYS_2026).toHaveLength(7);let count=0;
 for(const h of CHINA_HOLIDAYS_2026){const d=date(h.start);while(d<=date(h.end)){expect(chinaDay(d)).toMatchObject({isWorkday:false,holidayName:h.name,makeupWorkday:false,holidayTableCovered:true});expect(scenarioForDate(d)).toBe('abstain');count++;d.setDate(d.getDate()+1);}}
 expect(count).toBe(33);expect(CHINA_MAKEUP_WORKDAYS_2026).toEqual(['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']);
 for(const key of CHINA_MAKEUP_WORKDAYS_2026){expect(chinaDay(date(key))).toMatchObject({isWorkday:true,holidayName:null,makeupWorkday:true});expect(scenarioForDate(date(key))).toBe('normal');}
});
it.each([
 ['2026-10-12','normal'],['2026-10-11','abstain'],['2026-10-08','normal'],
 ['2026-05-29','normal'],['2026-06-01','peak'],['2026-06-18','peak'],['2026-06-19','abstain'],['2026-06-22','peak'],
 ['2026-07-23','peak'],['2026-07-25','abstain'],['2026-08-31','peak'],['2026-09-01','normal'],
 ['2026-02-13','normal'],['2026-02-24','normal'],['2026-04-03','normal'],['2026-04-07','normal'],['2026-05-06','normal'],['2026-09-28','normal'],
])('routes %s to %s without UI selection',(key,expected)=>expect(scenarioForDate(date(key))).toBe(expected));
it('ordinary weekends have no festival label; uncovered years explicitly fall back to weekdays/weekends',()=>{
 expect(chinaDay(date('2026-10-11')).holidayName).toBeNull();expect(chinaDay(date('2027-01-01'))).toMatchObject({holidayTableCovered:false,holidayName:null,isWorkday:true});
});
it('hidden overrides route data only; never change local date or holiday label',async()=>{
 for(const scenario of ['normal','peak','abstain']){const store=new DashboardStore(new MockAdapter(),undefined,{query:`?scenario=${scenario}&at=2026-10-12T14:00`});await store.initialize();expect(store.getSnapshot().scenario).toBe(scenario);expect(store.getSnapshot().data?.meta.scenario).toBe(scenario);expect(chinaDay(store.getSnapshot().nowMs).holidayName).toBeNull();store.dispose();}
 expect(scenarioOverride('?scenario=oops')).toBeNull();const store=new DashboardStore(new MockAdapter(),undefined,{query:'?scenario=oops&at=2026-07-23T14:00'});await store.initialize();expect(store.getSnapshot().scenario).toBe('peak');store.dispose();
});
it('midnight auto-switches weekday/summer/holiday routes, keeps hour zero and rejects old async data',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,5,18,23,59,59));const store=new DashboardStore(new MockAdapter(),undefined,{query:''});await store.initialize();expect(store.getSnapshot().scenario).toBe('peak');vi.advanceTimersByTime(1000);await Promise.resolve();expect(store.getSnapshot()).toMatchObject({scenario:'abstain',hour:0,time:0,loading:false});expect(store.getSnapshot().data?.meta.scenario).toBe('abstain');store.dispose();
 vi.setSystemTime(new Date(2026,4,31,23,59,59));let resolve!:(v:ReturnType<typeof mockReplay>)=>void;const source=new MockAdapter();source.loadScenario=vi.fn((id:string)=>id==='abstain'?new Promise<ReturnType<typeof mockReplay>>(r=>resolve=r):Promise.resolve(mockReplay(id)));const slow=new DashboardStore(source,undefined,{query:''});const init=slow.initialize();await Promise.resolve();vi.advanceTimersByTime(1000);await Promise.resolve();expect(slow.getSnapshot().scenario).toBe('peak');resolve(mockReplay('abstain'));await init;expect(slow.getSnapshot().data?.meta.scenario).toBe('peak');slow.dispose();
});
it('a pinned scenario remains pinned across midnight',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,5,18,23,59,59));const store=new DashboardStore(new MockAdapter(),undefined,{query:'?scenario=normal'});await store.initialize();vi.advanceTimersByTime(1000);expect(store.getSnapshot().scenario).toBe('normal');expect(store.getSnapshot().hour).toBe(0);store.dispose();
});
