export function LlmStatusBadge({ online }: { online?: boolean }) {
  return (
    <span
      className={`agent-tag agent-llm-badge${online === true ? "" : " agent-llm-inactive"}`}
    >
      {online === true
        ? "LLM 在线"
        : online === false
          ? "未接 LLM"
          : "LLM 检查中"}
    </span>
  );
}
