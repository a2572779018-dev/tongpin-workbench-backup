import { BookmarkCheck } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AiMemoryReviewStatus } from "../../../shared/aiMemory";
import { currentMemoryReviewSource, memoryReviewSummary, openMemberMemoryPanel, subscribeMemoryReviewSource } from "./memberMemoryClient";
import "./member-memory.css";

/** Settled review status for one reply; polls briefly while the background review runs. */
function useMemoryReviewStatus(requestId: string): AiMemoryReviewStatus | undefined {
  const source = useSyncExternalStore(subscribeMemoryReviewSource, currentMemoryReviewSource, () => null);
  const [status, setStatus] = useState<AiMemoryReviewStatus>();
  useEffect(() => {
    setStatus(undefined);
    return source?.watcher.watch(requestId, setStatus);
  }, [source, requestId]);
  return source ? status : undefined;
}

/** Subtle「已更新记忆」mark on a reply after its background review changed memory. */
export function MemoryUpdateIndicator({ requestId }: { requestId: string }) {
  const summary = memoryReviewSummary(useMemoryReviewStatus(requestId));
  if (!summary) return null;
  return <button type="button" className="tp-ai-memory-updated" onClick={openMemberMemoryPanel}
    title={`同频 AI 从这轮对话更新了对你的了解（${summary}），点击查看或修改`} aria-label={`已更新记忆：${summary}。查看 AI 对你的了解`}>
    <BookmarkCheck size={13} aria-hidden="true" />已更新记忆
  </button>;
}
