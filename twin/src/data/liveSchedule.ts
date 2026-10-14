import {displayDate as currentDisplayDate} from '../config/displayClock';
import { loadSchedule } from "../pages/agent/api";
import type { Decision } from "../pages/agent/types";
import type { ReplayData } from "./types";

// Reuse the existing request de-duplication and scheduleDecision validation.
// AgentPage's existing loadSchedule call therefore shares this exact promise/response.
export type LiveSchedule = Decision;
export type ScheduleLoader = (
  data: ReplayData,
  index: number,
  scenario: string,
  displayDate?:string,
) => Promise<LiveSchedule | null>;
export const loadLiveSchedule: ScheduleLoader = loadSchedule;
export function liveScheduleKey(
  scenario: string,
  building: string,
  origin: string,
  displayDate=currentDisplayDate(),
) {
  return `${scenario}|${building}|${origin}|${displayDate}`;
}
