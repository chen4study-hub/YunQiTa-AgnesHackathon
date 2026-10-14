import type { ChatAnswer } from "./types";
import { toolLabel } from "./chat-copy";

export function ChatToolTags({
  tools,
  toolNames,
}: Pick<ChatAnswer, "tools" | "toolNames">) {
  if (!tools.length) return null;
  return (
    <div className="agent-tool-tags">
      {tools.map((tool, i) => (
        <code key={`${tool}-${i}`}>{toolLabel(tool, toolNames?.[tool])}</code>
      ))}
    </div>
  );
}
