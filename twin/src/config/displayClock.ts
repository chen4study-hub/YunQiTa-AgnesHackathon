import {resolveClock} from './localClock';
import {localCalendarDate} from './displayTime';
/** Public default for transports called outside React (including AgentPage's unchanged API call). */
const readers:Array<()=>number>=[];
export function bindDisplayClock(reader:()=>number){
 readers.push(reader);return ()=>{const index=readers.indexOf(reader);if(index>=0)readers.splice(index,1);};
}
export function displayNowMs(){return readers.at(-1)?.()??resolveClock().read();}
export function displayDate(){return localCalendarDate(displayNowMs());}
