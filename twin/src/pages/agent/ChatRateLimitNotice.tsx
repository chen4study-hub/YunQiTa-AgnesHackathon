import { useEffect, useState } from "react";
import { chatRetrySeconds } from "./chat-rate-limit";

/** Wall-clock deadline stays accurate after background throttling or tab remount. */
export function useChatRetryClock(retryAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  return now;
}
export function ChatRateLimitNotice({
  retryAt,
  now,
}: {
  retryAt: number;
  now: number;
}) {
  const seconds = chatRetrySeconds(retryAt, now);
  return (
    <p className="agent-chat-rate-limit" role="status">
      {seconds > 0
        ? `提问太频繁了，请 ${seconds} 秒后再试`
        : "等待已结束，可以再次提问。"}
    </p>
  );
}
