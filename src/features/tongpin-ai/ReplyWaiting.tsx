import { useEffect, useState } from "react";

/** Keep one-second clock updates out of the conversation and persistence state. */
export function ReplyWaiting() {
  const [startedAt] = useState(Date.now);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="tp-ai-thinking" role="status" aria-live="off" aria-label="正在等待 AI 回复">
    <span /><span /><span />正在等待 · 已用时 {seconds} 秒
  </div>;
}
