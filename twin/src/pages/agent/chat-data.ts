import type { ChatAnswer } from "./types";

export const quickQuestions = [
  "为什么这样调度？",
  "未来24小时峰值是多少？",
  "为什么转人工？",
  "执行回执是什么？",
];
/** Never synthesize an answer or tool trace from local operational data. */
export function alignAnswer(
  answer: ChatAnswer | null,
  ..._context: unknown[]
): ChatAnswer {
  return (
    answer ?? { source: "backend", tools: [], text: "", requestError: true }
  );
}
