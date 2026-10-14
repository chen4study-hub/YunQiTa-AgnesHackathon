export interface Candidate {
  id: string;
  name: string;
  cost: number | null;
  peak: number | null;
  temp: number;
  battery: number;
  passed: boolean | null;
  basis: "接口工具" | "规则调度器";
  peakBasis?: "点负荷" | "区间上界";
}
export interface Ticket {
  id: string;
  reasons: string[];
  checks: string[];
  temp: number | null;
  battery: number | null;
}
export interface Decision {
  t: string;
  handoff: boolean;
  lifecycle?: "executed" | "handoff" | "manual";
  manualOperator?: string;
  upper: number;
  confidence: number;
  threshold: number;
  temp: number | null;
  battery: number | null;
  reason: string;
  /** Set only when the reason's opening upper value matches the full plan maximum. */
  reasonUpperWindowHours?: number;
  candidates: Candidate[];
  /** Number of hourly commands in the common cost-comparison window, not executed hours. */
  costWindowHours?: number;
  selected: string;
  /** Transport provenance, independent of selection and wording. */
  source: "schedule" | "replay";
  selectionSource?: "llm" | "rule" | "mock";
  explanationSource?: "llm" | "template";
  receipt: {
    /** Zero sentinel is never a claimed count unless known is true. */
    count: number;
    elapsed: number | null;
    transport: string;
    connected: boolean;
    known: boolean;
  };
  ticket: Ticket;
  grounding: boolean | null;
}
export type RecordStatus = "工程师微调" | "已撤销" | "已指派" | "已处理";
export interface ChatAnswer {
  text: string;
  tools: string[];
  toolNames?: Record<string, string>;
  source: "backend" | "preset";
  llmMode?: string;
  mode?: "llm" | "fallback";
  requestError?: boolean;
  rateLimit?: { retryAt: number };
  needsHuman?: boolean;
  terminated?: boolean;
  category?: string;
}
export interface ChatProcessRow {
  id: number;
  kind: "step" | "tool" | "error" | "progress";
  progressId?: string;
  text: string;
  tool?: string;
  name?: string;
  state?: "running" | "done" | "error";
  ms?: number;
  summary?: string;
}
export interface ChatMessage extends ChatAnswer {
  displayContext?: { scenario: string; origin: string; nowMs: number };
  id: number;
  role: "user" | "assistant";
  pending?: boolean;
  waitFinished?: boolean;
  fallback?: boolean;
  process?: ChatProcessRow[];
  elapsed?: number;
}
export type JsonRecord = Record<string, unknown>;
