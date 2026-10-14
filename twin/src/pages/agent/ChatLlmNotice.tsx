import type { ChatMessage } from "./types";

// User-requested exact copy: the sole UI exception for the word 演示.
export const LLM_LIMIT_NOTICE =
  "为避免API Key泄漏，演示站点不调用LLM，体验可能受限";

export function ChatLlmNotice({
  online,
  messages,
}: {
  online?: boolean;
  messages: readonly Pick<ChatMessage, "role">[];
}) {
  if (online !== false || !messages.some((m) => m.role === "user")) return null;
  return (
    <div className="agent-llm-notice" role="status">
      {LLM_LIMIT_NOTICE}
    </div>
  );
}
