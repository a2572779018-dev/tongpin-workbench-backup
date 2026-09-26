import { useEffect, useState } from "react";

/** Neutral placeholder shown only until the first real run event arrives.
 * Keep one-second clock updates out of the conversation while preserving the request's real start time. */
export function ReplyWaiting({ startedAt: persistedStartedAt }: { startedAt?: number }) {
  const [startedAt] = useState(() => Number.isSafeInteger(persistedStartedAt) && persistedStartedAt! >= 0 ? persistedStartedAt! : Date.now());
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="tp-ai-thinking" role="status" aria-live="off" aria-label="等待模型响应">
    <span /><span /><span />等待模型响应 · 已用时 {seconds} 秒
  </div>;
}
