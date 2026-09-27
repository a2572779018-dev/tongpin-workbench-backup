import { BookmarkCheck, History, Lightbulb, Sparkles } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { AiMemoryReviewStatus } from "../../../shared/aiMemory";
import type { AiMemoryRecallEvent } from "../../../shared/aiMemoryLearning";
import { currentMemoryReviewSource, memoryReviewSummary, openMemberMemoryPanel, subscribeMemoryReviewSource } from "./memberMemoryClient";
import { loadRecallDetail, recallDateLabel, replyActivityLines } from "./memberLearningClient";
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

/** The history excerpts one reply used — the member's own conversations only. */
function RecallExcerpts({ requestId, id }: { requestId: string; id: string }) {
  const [detail, setDetail] = useState<AiMemoryRecallEvent | null | "error">();
  useEffect(() => {
    let alive = true;
    loadRecallDetail(requestId).then(value => { if (alive) setDetail(value); }, () => { if (alive) setDetail("error"); });
    return () => { alive = false; };
  }, [requestId]);
  if (detail === undefined) return <p id={id} className="tp-ai-recall-excerpts" role="status">正在读取…</p>;
  if (detail === "error") return <p id={id} className="tp-ai-recall-excerpts" role="alert">暂时无法读取回忆内容，请稍后再试。</p>;
  if (!detail || !detail.snippets.length) return <p id={id} className="tp-ai-recall-excerpts">这次没有用到历史对话（可能已被删除或清空）。</p>;
  return <ol id={id} className="tp-ai-recall-excerpts" aria-label="这次回复参考的历史对话">
    {detail.snippets.map((snippet, index) => <li key={index}>
      <small>《{snippet.conversationTitle}》· {recallDateLabel(snippet.date)} · {snippet.role === "user" ? "你说" : "同频 AI 回复"}</small>
      <p>{snippet.excerpt}</p>
    </li>)}
  </ol>;
}

/**
 * Small process lines under a settled reply: history recalled (click to see
 * the excerpts), personal skills used, memory updated, a skill learned.
 */
export function MemoryUpdateIndicator({ requestId }: { requestId: string }) {
  const status = useMemoryReviewStatus(requestId);
  const summary = memoryReviewSummary(status);
  const lines = replyActivityLines(status);
  const [open, setOpen] = useState(false);
  const excerptsId = useId();
  if (!summary && !lines.recall && !lines.skills && !lines.skillProposed) return null;
  return <div className="tp-ai-memory-activity">
    {lines.recall ? <button type="button" className="tp-ai-memory-updated is-recall" aria-expanded={open} aria-controls={open ? excerptsId : undefined}
      title="查看这次回复参考了哪些历史对话" onClick={() => setOpen(value => !value)}>
      <History size={13} aria-hidden="true" />{lines.recall}
    </button> : null}
    {lines.skills ? <button type="button" className="tp-ai-memory-updated is-skill" onClick={openMemberMemoryPanel} title="这次回复按你采纳的个人技能来做，点击查看或修改">
      <Sparkles size={13} aria-hidden="true" />{lines.skills}
    </button> : null}
    {summary ? <button type="button" className="tp-ai-memory-updated" onClick={openMemberMemoryPanel}
      title={`同频 AI 从这轮对话更新了对你的了解（${summary}），点击查看或修改`} aria-label={`已更新记忆：${summary}。查看 AI 对你的了解`}>
      <BookmarkCheck size={13} aria-hidden="true" />已更新记忆
    </button> : null}
    {lines.skillProposed ? <button type="button" className="tp-ai-memory-updated is-skill" onClick={openMemberMemoryPanel} title="同频 AI 从这类任务中总结出一个做法，采纳后才会生效">
      <Lightbulb size={13} aria-hidden="true" />学到一个新技能，待你确认
    </button> : null}
    {open && lines.recall ? <RecallExcerpts requestId={requestId} id={excerptsId} /> : null}
  </div>;
}
